var URL = require('url')
var memoizee = require('memoizee')
var swagger = require('swagger-client')
var swaggerTools = require('swagger-tools').specs.v1

var utils = require('./utils')
var primitives = require('./primitives')

let globalOpts = {};

function primitive (schema) {
  schema = utils.objectify(schema)

  var type = schema.type
  var format = schema.format
  var value = primitives[type + '_' + format] || primitives[type]

  if (typeof schema.example === 'undefined') {
    return value || 'Unknown Type: ' + schema.type
  }

  return schema.example
}

function sampleFromSchema (schema) {
  schema = utils.objectify(schema)

  var type = schema.type
  var properties = schema.properties
  var additionalProperties = schema.additionalProperties
  var items = schema.items

  if (!type) {
    if (properties) {
      type = 'object'
    } else if (items) {
      type = 'array'
    } else {
      return
    }
  }

  if (type === 'object') {
    var props = utils.objectify(properties)
    var obj = {}
    for (var name in props) {
      var value = sampleFromSchema(props[name]);
      // 如果是数组，并且设置了arrayMockNum
      if (props[name].type === 'array' && globalOpts.arrayMockNum) {
        var {min, max} = globalOpts.arrayMockNum;
        obj[`${name}|${min}-${max}`] = value;
      } else {
        obj[name] = value;
      }
    }

    if (additionalProperties === true) {
      obj.additionalProp1 = {}
    } else if (additionalProperties) {
      var additionalProps = utils.objectify(additionalProperties)
      var additionalPropVal = sampleFromSchema(additionalProps)

      for (var i = 1; i < 4; i++) {
        obj['additionalProp' + i] = additionalPropVal
      }
    }
    return obj
  }

  if (type === 'array') {
    return [sampleFromSchema(items)]
  }

  if (schema['enum']) {
    if (schema['default']) return schema['default']
    return utils.normalizeArray(schema['enum'])[0]
  }

  if (type === 'file') {
    return
  }

  return primitive(schema)
}

var memoizedSampleFromSchema = memoizee(sampleFromSchema)

function getSampleSchema (schema) {
  var res = memoizedSampleFromSchema(schema);
  // 格式化
  if (globalOpts.formatter) {
    res = globalOpts.formatter(res);
  }
  return JSON.stringify(res, null, 2)
}

/**
 * 处理 1.x 文档中，array 类型下 items.type 无法解析 model 的问题
 *
 * { a: { type: 'array', items: { type: 'Pet' } }, models: { Pet: {} } }
 * =>
 * { a: { type: 'array', items: { $ref: 'Pet' } }, models: { Pet: {} } }
 *
 * @param {*} obj
 * @param {*} models
 */
function renameTypeKey (obj, models) {
  models = models || {}
  if (!obj || (obj && typeof obj !== 'object')) return
  Object.keys(obj).forEach(key => {
    const value = obj[key]
    if (value && typeof value === 'object') {
      renameTypeKey(value, models)
    }

    if (key === 'type' &&
      value === 'array' &&
      obj.items &&
      obj.items.type &&
      models[obj.items.type]) {
      obj.items.$ref = obj.items.type
      delete obj.items.type
    }
  })
}

function objectFilter(obj, handler) {
  const keys = Object.keys(obj).filter(handler);
  const res = {};
  keys.forEach(key => {
    res[key] = obj[key];
  });
  return res;
}

var parser = module.exports = function (url, opts) {
  opts = opts || {}
  var filterReg = opts.filterReg;
  if (typeof url === 'string') {
    opts.url = url
  } else {
    opts = url
  }
  globalOpts = opts;

  return swagger(opts).then(function (res) {
    var spec = res.spec
    var isOAS3 = spec.openapi && spec.openapi === '3.0.0'

    if (spec.swaggerVersion) { // v1
      var paths = spec.apis.map(function (api) {
        var baseUrl = res.url
        if (!/\.json$/.test(baseUrl)) {
          baseUrl += '/'
        }
        opts.url = URL.resolve(baseUrl, api.path.replace(/^\//, ''))
        if (!opts.filterReg.test(opts.url)) {
          return;
        }
        return swagger(opts)
      }).filter(item => !!item);
      return Promise.all(paths).then(function (apis) {
        var specs = apis.map(function (o) { return o.spec })
        return new Promise(function (resolve, reject) {
          for (let spec of specs) {
            renameTypeKey(spec, spec.models)
          }
          swaggerTools.convert(spec, specs, true, function (error, docs) {
            if (error) return reject(error)
            resolve(parser({ spec: docs }))
          })
        })
      })
    } else {
      spec.paths = objectFilter(spec.paths, (path) => {
        return filterReg.test(path)
      });
      for (var path in spec.paths) {
        for (var method in spec.paths[path]) {
          var api = spec.paths[path][method]
          var schema
          for (var code in api.responses) {
            var response = api.responses[code]
            if (isOAS3) {
              schema = response.content &&
                response.content['application/json'] &&
                utils.inferSchema(response.content['application/json'])
              response.example = schema ? getSampleSchema(schema) : null
            } else {
              schema = utils.inferSchema(response)
              response.example = schema ? getSampleSchema(schema) : null
            }
          }
          if (!api.parameters) continue
          for (var parameter of api.parameters) {
            schema = utils.inferSchema(parameter)
            parameter.example = schema ? getSampleSchema(schema) : null
          }
        }
      }
    }
    return spec
  })
}
