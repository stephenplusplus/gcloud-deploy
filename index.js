'use strict'

var archiver = require('archiver')
var async = require('async')
var EE = require('events').EventEmitter
var gcloud = require('gcloud')
var multiline = require('multiline')
var path = require('path')

module.exports = function (pkgRoot) {
  pkgRoot = pkgRoot || process.cwd()

  var ee = new EE()
  var pkg = require(path.join(pkgRoot, 'package.json'))
  var gcloudConfig = pkg.gcloud || {}

  var gcloudInstance = gcloud(gcloudConfig)
  var gcs = gcloudInstance.storage()
  var gce = gcloudInstance.compute()

  var tarFile // populated later after it's created so that it can be deleted

  async.waterfall([uploadTar, createVM, startVM], onComplete)

  function uploadTar (callback) {
    var bucketName = gcloudConfig.projectId + '-gcloud-deploy-tars'
    var bucket = gcs.bucket(bucketName)
    var tarFilename = Date.now() + '.tar'

    gcs.createBucket(bucketName, function (err) {
      if (err && err.code !== 409) return callback(err)
      ee.emit('bucket', bucket)

      tarFile = bucket.file(tarFilename)

      var tar = archiver.create('tar', { gzip: true })
      tar.directory(pkgRoot, false)
      tar.finalize()

      tar.pipe(tarFile.createWriteStream())
        .on('error', callback)
        .on('finish', function () {
          ee.emit('file', tarFile)
          tarFile.makePublic(function (err) {
            if (err) return callback(err)
            callback(null, tarFile)
          })
        })
    })
  }

  function createVM (file, callback) {
    var startupScript = multiline(function () {/*
      #! /bin/bash
      export NVM_DIR=/opt/nvm
      curl -o- https://raw.githubusercontent.com/creationix/nvm/v0.29.0/install.sh | bash
      source /opt/nvm/nvm.sh
      nvm install v0
      mkdir /opt/app && cd $_
      curl https://storage.googleapis.com/{bucketName}/{tarFilename} | tar -xz
      npm install
      npm start
    */})
   .replace('{bucketName}', file.bucket.name)
   .replace('{tarFilename}', file.name)

    var vmName = pkg.name + '-' + Date.now()

    var cfg = {
      os: 'debian',
      http: true,
      https: true,
      metadata: {
        items: [{ key: 'startup-script', value: startupScript }]
      }
    }

    gce.zone('us-central1-a').createVM(vmName, cfg, _onOperationComplete(function (err, vm) {
      if (err) return callback(err)
      ee.emit('vm', vm)
      callback(null, vm)
    }))
  }

  function startVM (vm, callback) {
    vm.start(_onOperationComplete(function (err) {
      if (err) return callback(err)

      vm.getMetadata(function (err, metadata) {
        if (err) return callback(err)
        ee.emit('start', 'http://' + metadata.networkInterfaces[0].accessConfigs[0].natIP)
      })
    }))
  }

  function onComplete (err, objects) {
    if (err) return ee.emit('error', err)

    tarFile.delete(function (err) {
      if (err) ee.emit('error', err)
      ee.removeAllListeners()
    })
  }

  function _onOperationComplete (callback) {
    return function (err, operation, apiResponse) {
      if (err) return callback(err)

      if (arguments.length === 4) {
        var object = operation
        operation = apiResponse
      }

      operation.onComplete(function (err, metadata) {
        if (object) callback(err, object, metadata)
        else callback(err, metadata)
      })
    }
  }

  return ee
}
