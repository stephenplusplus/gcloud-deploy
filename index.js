'use strict'

var archiver = require('archiver')
var async = require('async')
var EE = require('events').EventEmitter
var format = require('string-format-obj')
var gcloud = require('gcloud')
var multiline = require('multiline')
var path = require('path')
var split = require('split-array-stream')
var slug = require('slug')
var through = require('through2')

module.exports = function (pkgRoot) {
  pkgRoot = pkgRoot || process.cwd()

  var ee = new EE()

  var pkg = require(path.join(pkgRoot, 'package.json'))
  var gcloudConfig = pkg.gcloud || {}

  var gcloudInstance = gcloud(gcloudConfig)
  var gcs = gcloudInstance.storage()
  var gce = gcloudInstance.compute()

  async.waterfall([
    createTarStream,
    uploadTar,
    createVM,
    startVM
  ], function (err) {
    if (err) return ee.emit('error', err)
    ee.removeAllListeners()
  })

  function createTarStream (callback) {
    var tarStream = archiver.create('tar', { gzip: true })
    tarStream.bulk([{ expand: true, cwd: pkgRoot, src: ['**', '!node_modules/**'] }])
    tarStream.finalize()
    callback(null, tarStream)
  }

  function uploadTar (tarStream, callback) {
    var bucketName = gcloudConfig.projectId + '-gcloud-deploy-tars'
    var bucket = gcs.bucket(bucketName)
    var tarFilename = Date.now() + '.tar'

    gcs.createBucket(bucketName, function (err) {
      if (err && err.code !== 409) return callback(err)
      ee.emit('bucket', bucket)

      var tarFile = bucket.file(tarFilename)

      tarStream.pipe(tarFile.createWriteStream({ gzip: true }))
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
    var startupScript = format(multiline(function () {/*
      #! /bin/bash
      set -v
      apt-get update
      apt-get install -yq build-essential
      export NVM_DIR=/opt/nvm
      curl -o- https://raw.githubusercontent.com/creationix/nvm/v0.29.0/install.sh | bash
      source /opt/nvm/nvm.sh
      nvm install v0
      mkdir /opt/app && cd $_
      curl https://storage.googleapis.com/{bucketName}/{fileName} | tar -xz
      npm install
      npm start &
    */}), { bucketName: file.bucket.name, fileName: file.name })

    var vmName = slug(pkg.name) + '-' + Date.now()

    var cfg = {
      os: 'centos',
      http: true,
      https: true,
      metadata: {
        items: [{ key: 'startup-script', value: startupScript }]
      }
    }

    gce.zone('us-central1-a').createVM(vmName, cfg, _onOperationComplete(function (err, vm, metadata) {
      if (err) return callback(err)
      ee.emit('vm', vm)
      callback(null, vm)
    }))
  }

  function startVM (vm, callback) {
    if (EE.listenerCount(ee, 'output')) logOutput(vm)

    vm.start(_onOperationComplete(function (err) {
      if (err) return callback(err)

      vm.getMetadata(function (err, metadata) {
        if (err) return callback(err)
        ee.emit('start', 'http://' + metadata.networkInterfaces[0].accessConfigs[0].natIP)
        callback()
      })
    }))
  }

  function logOutput (vm) {
    var outputStream = through({ encoding: 'utf8' })

    var url
    var outputLog = ''

    var refresh = function () {
      vm.getSerialPortOutput(function (err, output) {
        if (err) return ee.emit('error', err)

        var newOutput

        if (outputLog) {
          newOutput = output.replace(outputLog, '')
          outputLog += newOutput
        } else {
          outputLog = output
          newOutput = output
        }

        var logLines = newOutput.split('\r\n').map(function (str) {
          // put the network url in the log output and remove some of the noise
          return str.replace(new RegExp(vm.name + '[^:]*', 'g'), '(' + url + ')').trim()
        })

        split(logLines, outputStream, function (streamEnded) {
          if (!streamEnded) setTimeout(refresh, 250)
        })
      })
    }

    ee.once('start', function (_url) {
      url = _url
      ee.emit('output', outputStream)
      refresh()
    })
  }

  return ee
}

// helper to wait for an operation to complete before executing the callback
// this also supports creation callbacks, specifically `createVM`, which has an
// extra arg with the instance object of the created VM
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
