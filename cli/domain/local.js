'use strict';

var config = require('../../conf');
var format = require('../../utils/format');
var fs = require('fs-extra');
var hashBuilder = require('../../utils/hash-builder');
var request = require('../../utils/request');
var path = require('path');
var Targz = require('tar.gz');
var uglifyJs = require('uglify-js');
var validator = require('../../registry/domain/validator');
var _ = require('underscore');

module.exports = function(){

  var targz = new Targz();

  var javaScriptizeTemplate = function(functionName, data){
    var jsNameSpace = 'oc';

    return 'var ' + jsNameSpace + ' = ' + jsNameSpace + ' || {}; ' +
           jsNameSpace + '.components = ' + jsNameSpace + '.components || {}; ' +
           jsNameSpace + '.components[\'' + functionName + '\'] = ' + data.toString();
  };

  return _.extend(this, {
    cleanup: function(compressedPackagePath, callback){
      return fs.unlink(compressedPackagePath, callback);
    },
    compress: function(input, output, callback){
      return targz.compress(input, output, callback);
    },
    getComponentsByDir: function(componentsDir, callback){

      try {
        var components = fs.readdirSync(componentsDir).filter(function(file){

          var filePath = path.resolve(componentsDir, file),
              isDir = fs.lstatSync(filePath).isDirectory();

          return isDir ? (fs.readdirSync(filePath).filter(function(file){
           return file === 'package.json';
          }).length === 1) : false;
        });

        var fullPathComponents = _.map(components, function(component){
          return path.resolve(componentsDir, component);
        });

        callback(null, fullPathComponents);

      } catch(err){
        return callback(err);
      }
    },
    getLocalNpmModules: function(componentsDir){

      var nodeFolder = path.join(componentsDir, 'node_modules');

      if(!fs.existsSync(nodeFolder)){
        return [];
      }

      return fs.readdirSync(nodeFolder).filter(function(file){

        var filePath = path.resolve(nodeFolder, file),
            isDir = fs.lstatSync(filePath).isDirectory();

        return isDir;
      });
    },
    info: function(callback){
      return fs.readJson(config.configFile.src, callback);
    },
    init: function(componentName, callback){

      if(!validator.validateComponentName(componentName)){
        return callback('name not valid');
      }

      try {
        var baseComponentDir = path.resolve(__dirname, '../base-component'),
            npmIgnorePath = path.resolve(__dirname, '../base-component/.npmignore');

        fs.ensureDirSync(componentName);
        fs.copySync(baseComponentDir, componentName);
        fs.copySync(npmIgnorePath, componentName + '/.gitignore');
        
        var componentPath = path.resolve(componentName, 'package.json'),
            component = _.extend(fs.readJsonSync(componentPath), {
              name: componentName
            });

        fs.outputJsonSync(componentPath, component);

        return callback(null, { ok: true });
      } catch(e){
        return callback(e);
      }
    },
    link: function(componentName, componentVersion, callback){

      var localConfig = fs.readJsonSync(config.configFile.src);

      if(!localConfig || !localConfig.registries || localConfig.registries.length === 0){
        return callback('Registry configuration not found. Add a registry reference to the project first');
      }

      localConfig.components = localConfig.components || {};

      if(!!localConfig.components[componentName]){
        return callback('Component already linked in the project');
      }

      var componentHref = format('{0}/{1}/{2}', localConfig.registries[0], componentName, componentVersion);

      request(componentHref, function(err, res){
        if(err || !res){
          return callback('Component not available');
        }

        try {
          var apiResponse = JSON.parse(res);
          if(apiResponse.type !== 'oc-component'){
            return callback('not a valid oc Component');
          }
        } catch(e){
          return callback('not a valid oc Component');
        }

        localConfig.components[componentName] = componentVersion;
        fs.writeJson(config.configFile.src, localConfig, callback);
      });
    },
    package: function(componentPath, callback){

      var files = fs.readdirSync(componentPath),
          publishPath = path.join(componentPath, '_package');

      if(_.contains(files, '_package')){
        fs.removeSync(publishPath);
      }

      fs.mkdirSync(publishPath);

      var component = fs.readJsonSync(path.join(componentPath, 'package.json')),
          template = fs.readFileSync(path.join(componentPath, component.oc.files.template.src)).toString();

      if(!validator.validateComponentName(component.name)){
        return callback('name not valid');
      }

      if(component.oc.files.template.type === 'handlebars'){

        var handlebars = require('handlebars'),
            preCompiled = handlebars.precompile(template),
            hash = hashBuilder.fromString(preCompiled.toString()),
            templateJs = javaScriptizeTemplate(hash, preCompiled),
            minifiedTemplateJs = uglifyJs.minify(templateJs, {fromString: true}).code;

        fs.writeFileSync(path.join(publishPath, 'template.js'), minifiedTemplateJs);

        component.oc.files.template = {
          type: 'handlebars',
          hashKey: hash,
          src: 'template.js'
        };

        delete component.oc.files.client;

      } else {
        return callback('template type not supported');
      }
      
      if(!!component.oc.files.data){
        var dataPath = path.join(componentPath, component.oc.files.data);

        fs.copySync(dataPath, path.join(publishPath, 'server.js'));
        component.oc.files.dataProvider = {
          type: 'node.js',
          haskey: hashBuilder.fromString(fs.readFileSync(dataPath)),
          src: 'server.js'
        };

        delete component.oc.files.data;
      }

      if(component.oc.files.static){
        if(!_.isArray(component.oc.files.static)){
          component.oc.files.static = [component.oc.files.static];
        }

        _.forEach(component.oc.files.static, function(staticComponent){
          fs.copySync(path.join(componentPath, staticComponent), path.join(publishPath, staticComponent));
        });
      }

      fs.writeJsonSync(path.join(publishPath, 'package.json'), component);
      callback(null, component);
    },
    unlink: function(componentName, callback){
      var localConfig = fs.readJsonSync(config.configFile.src) || {};
      
      if(!!localConfig.components[componentName]){
        delete localConfig.components[componentName];
      }
      
      fs.writeJson(config.configFile.src, localConfig, callback);
    },
  });
};