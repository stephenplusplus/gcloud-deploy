'use strict'

var archiver = require('archiver')
var assign = require('deep-assign')
var async = require('async')
var format = require('string-format-obj')
var gcloud = require('gcloud')
var multiline = require('multiline')
var outputStream = require('gce-output-stream')
var path = require('path')
var pumpify = require('pumpify')
var slug = require('slug')
var through = require('through2')

var resolveConfig = function (pkg, explicitConfig) {
  var config = {
    root: process.cwd(),
    nodeVersion: 'stable',

    gcloud: {
      projectId: process.env.GCLOUD_PROJECT_ID,
      keyFile: process.env.GCLOUD_KEY_FILE
    },

    vm: {
      zone: process.env.GCLOUD_ZONE || 'us-central1-a',
      os: 'centos',
      http: true,
      https: true
    }
  }

  assign(config, pkg.gcloudDeploy, explicitConfig)

  // gcloud wants `keyFilename`
  config.gcloud.keyFilename = config.gcloud.keyFile
  delete config.gcloud.keyFile

  if (!config.gcloud.projectId) {
    throw new Error('A projectId is required')
  }

  if (!config.gcloud.credentials && !config.gcloud.keyFilename) {
    throw new Error('Authentication with a credentials object or keyFile path is required')
  }

  return config
}

module.exports = function (config) {
  if (typeof config !== 'object') config = { root: config || process.cwd() }

  var pkg = require(path.join(config.root, 'package.json'))
  config = resolveConfig(pkg, config)

  var gcloudConfig = config.gcloud
  var pkgRoot = config.root
  var uniqueId = slug(pkg.name, { lower: true }) + '-' + Date.now()

  var gcloudInstance = gcloud(gcloudConfig)
  var gcs = gcloudInstance.storage()
  var gce = gcloudInstance.compute()

  var deployStream = pumpify()

  async.waterfall([
    createTarStream,
    uploadTar,
    createVM,
    startVM
  ], function (err, vm) {
    if (err) return deployStream.destroy(err)

    var outputCfg = assign({}, gcloudConfig, { name: vm.name, zone: vm.zone.name })

    outputCfg.authConfig = {}
    if (gcloudConfig.credentials) outputCfg.authConfig.credentials = gcloudConfig.credentials
    if (gcloudConfig.keyFilename) outputCfg.authConfig.keyFile = gcloudConfig.keyFilename

    deployStream.setPipeline(outputStream(outputCfg), through())

    // sniff the output stream for when it's safe to delete the tar file
    deleteTarFile(outputStream(outputCfg))
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

    gcs.createBucket(bucketName, function (err) {
      if (err && err.code !== 409) return callback(err)
      deployStream.emit('bucket', bucket)
      deployStream.bucket = bucket

      var tarFile = bucket.file(uniqueId + '.tar')

      tarStream.pipe(tarFile.createWriteStream({ gzip: true }))
        .on('error', callback)
        .on('finish', function () {
          deployStream.emit('file', tarFile)
          deployStream.file = tarFile

          tarFile.makePublic(function (err) {
            if (err) return callback(err)
            callback(null, tarFile)
          })
        })
    })
  }

  function createVM (file, callback) {
    var vmCfg = config.vm

    // most node apps will have dependencies that requires compiling. without
    // these build tools, the libraries might not install
    var installBuildEssentialsCommands = {
      debian: multiline.stripIndent(function () {/*
        apt-get update
        apt-get install -yq build-essential git-core
      */}),

      fedora: multiline.stripIndent(function () {/*
        yum -y groupinstall "Development Tools" "Development Libraries"
      */}),

      suse: multiline.stripIndent(function () {/*
        sudo zypper --non-interactive addrepo http://download.opensuse.org/distribution/13.2/repo/oss/ repo
        sudo zypper --non-interactive --no-gpg-checks rm product:SLES-12-0.x86_64 cpp48-4.8.3+r212056-11.2.x86_64 suse-build-key-12.0-4.1.noarch
        sudo zypper --non-interactive --no-gpg-checks install --auto-agree-with-licenses --type pattern devel_basis
      */})
    }

    var installBuildEssentialsCommand

    switch (vmCfg.os) {
      case 'centos':
      case 'centos-cloud':
      case 'redhat':
      case 'rhel':
      case 'rhel-cloud':
        installBuildEssentialsCommand = installBuildEssentialsCommands.fedora
        break

      case 'suse':
      case 'suse-cloud':
      case 'opensuse':
      case 'opensuse-cloud':
        installBuildEssentialsCommand = installBuildEssentialsCommands.suse
        break

      case 'debian':
      case 'debian-cloud':
      case 'ubuntu':
      case 'ubuntu-cloud':
      case 'ubuntu-os-cloud':
      default:
        installBuildEssentialsCommand = installBuildEssentialsCommands.debian
        break
    }

    var startupScript = format(multiline.stripIndent(function () {/*
      #! /bin/bash
      set -v
      {installBuildEssentialsCommand}
      {customStartupScript}
      export NVM_DIR=/usr/local/nvm
      export HOME=/root
      export GCLOUD_VM=true
      curl -o- https://raw.githubusercontent.com/creationix/nvm/v0.29.0/install.sh | bash
      source /usr/local/nvm/nvm.sh
      nvm install v{version}
      if [ ! -d /opt/app ]; then
        mkdir /opt/app
      fi
      cd /opt/app
      curl https://storage.googleapis.com/{bucketName}/{fileName} | tar -xz
      npm install --only-production
      npm start &
    */}), {
      installBuildEssentialsCommand: installBuildEssentialsCommand,
      customStartupScript: config.startupScript || '',
      bucketName: file.bucket.name,
      fileName: file.name,
      version: config.nodeVersion
    })

    vmCfg.metadata = vmCfg.metadata || {}
    vmCfg.metadata.items = vmCfg.metadata.items || []
    vmCfg.metadata.items.push({ key: 'startup-script', value: startupScript })

    var zone = gce.zone(vmCfg.zone)

    var onVMReady = function (vm) {
      deployStream.emit('vm', vm)
      deployStream.vm = vm

      callback(null, vm)
    }

    var vm = zone.vm(vmCfg.name || uniqueId)

    if (vmCfg.name) {
      // re-use an existing VM
      // @tood implement `setMetadata` in gcloud-node#vm
      vm.setMetadata({
        'startup-script': startupScript
      }, _onOperationComplete(function (err) {
        if (err) return callback(err)
        onVMReady(vm)
      }))
    } else {
      // create a VM
      vm.create(vmCfg, _onOperationComplete(function (err) {
        if (err) return callback(err)
        onVMReady(vm)
      }))
    }
  }

  function startVM (vm, callback) {
    // if re-using a VM, we have to stop & start to apply the new startup script
    vm.stop(_onOperationComplete(function (err) {
      if (err) return callback(err)

      vm.start(_onOperationComplete(function (err) {
        if (err) return callback(err)

        vm.getMetadata(function (err, metadata) {
          if (err) return callback(err)

          var url = 'http://' + metadata.networkInterfaces[0].accessConfigs[0].natIP
          deployStream.emit('start', url)
          deployStream.url = url

          callback(null, vm)
        })
      }))
    }))
  }

  function deleteTarFile (outputStream) {
    var tarFile = deployStream.file
    var startupScriptStarted = false

    outputStream.pipe(through(function (outputLine, enc, next) {
      outputLine = outputLine.toString('utf8')

      startupScriptStarted = startupScriptStarted || outputLine.indexOf('Starting Google Compute Engine user scripts') > -1

      // if npm install is running, the file has already been downloaded
      if (startupScriptStarted && outputLine.indexOf('npm install') > -1) {
        outputStream.end()

        tarFile.delete(function (err, apiResponse) {
          if (err) {
            var error = new Error('The tar file (' + tarFile.name + ') could not be deleted')
            error.response = apiResponse
            deployStream.destroy(error)
          }
        })
      } else {
        next()
      }
    }))
  }

  return deployStream
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

    operation
      .on('error', callback)
      .on('complete', callback.bind(null, null))
  }
}
