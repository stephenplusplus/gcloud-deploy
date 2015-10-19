# gcloud-deploy
> Quickly deploy a Node.js project on Google Compute Engine

## Getting Started

  - [How it works](#how-it-works)
  - [Prerequisites](#prerequisites)
  - [Configuration](#configuration)
  - [API](#api)
  - [Contributions](#contributions)


### Quick Start

See [gcloud-deploy Boilerplate](https://github.com/stephenplusplus/gcloud-deploy-boilerplate).

### CLI
```sh
$ npm install -g gcloud-deploy
$ gcloud-deploy
Backup created: grape-spaceship-123-gcloud-deploy-tars/1444765984324.tar
VM created: my-app-1444765984324
Deployed successfully! http://146.148.48.123
```

### Programmatically
```sh
$ npm install --save gcloud-deploy
```
```js
var gcloudDeploy = require('gcloud-deploy')

// Give it a Node.js project
gcloudDeploy('./')
  // A VM was created (`vm` is a gcloud-node VM object)
  .on('vm', function (vm) {})

  // App is being served at `url`
  .on('start', function (url) {})

  // raw output from the server while it initializes & starts your app
  .pipe(process.stdout)
```

### npm script
```sh
$ npm install --save-dev gcloud-deploy
```
```json
{
  "name": "my-app",
  "devDependencies": {
    "gcloud-deploy": "*"
  },
  "scripts": {
    "deploy": "gcloud-deploy"
  }
}
```
```sh
$ npm run deploy
```


## How it works

This module...

  1. makes a tarball of your project
  1. uploads it to a bucket
  1. creates a Compute Engine instance with a startup script to:
    1. install Node.js v0.12
    1. unpack the tarball
    1. run `npm start`


## Prerequisites

There are only two things required to use `gcloud-deploy`:

  - A Google Developers Console project ID to deploy your project to
  - A key file that contains credentials to authenticate API requests

If you haven't already, you will need to create a project in the [Google Developers Console](https://console.developers.google.com/project).

For a more detailed guide, see the *"On Your Own Server"* section of [gcloud-node's Authentication document](https://googlecloudplatform.github.io/gcloud-node/#/authentication).

The APIs that **must be enabled** are:

  - **Google Compute Engine**
  - **Google Cloud Storage**

The guide linked above will also guide you through creating a JSON keyfile.


## Configuration

This library tries to provide sane defaults for your VM. As explained in the `Prerequisites` section, all that is required are two properties:

  - `projectId` - The project to deploy the VM to.
  - `keyFile` - A path to a JSON, PEM, or P12 key file.

If you need further customization beyond the defaults, we accept configuration in a few different ways, which are listed below with examples.

These two links will be important:

  - [Connection configuration](https://googlecloudplatform.github.io/gcloud-node/#/docs/v0.24.0?method=gcloud)
  - [VM configuration](https://googlecloudplatform.github.io/gcloud-node/#/docs/v0.24.0/compute/zone?method=createVM)

<a name="config"></a>
### Configuration Object

When running programmatically, this may be the simplest, most consistent option. You can provide explicit configuration with a `config` object.

```js
var config = {
  gcloud: {
    // Same as the `config` object documented here:
    // https://googlecloudplatform.github.io/gcloud-node/#/docs/v0.24.0?method=gcloud
  },

  vm: {
    // Same as the `config` object documented here:
    // https://googlecloudplatform.github.io/gcloud-node/#/docs/v0.24.0/compute/zone?method=createVM
  }
}

gcloudDeploy(config)
```

Additionally, you can provide a `config.vm.zone` string to specify the zone to create your VM in.

#### Defaults

See how the default configuration is trumped by the [package.json's `gcloudDeploy`](#packageJson) object, then finally the [`config` object](#config).

```js
var defaults = {
  root: process.cwd(),
  nodeVersion: '0', // the latest Node.js version 0.x release

  gcloud: {
    projectId: process.env.GCLOUD_PROJECT_ID,
    keyFile: process.env.GCLOUD_KEY_FILE
  },

  vm: {
    zone: process.env.GCLOUD_ZONE || 'us-central1-a',
    name: slugify(packageJson.name) + '-' + Date.now(),
    os: 'centos',
    http: true,
    https: true
  }
}

deepExtend(defaults, packageJson.gcloudDeploy, config)
```

<a name="packageJson"></a>
### package.json

You may also create `gcloud` and `vm` properties inside of the deployed project's `package.json` in the same format as described above in [Configuration Object](#config).

An example `package.json`:

```json
{
  "name": "my-app",
  "version": "0.0.0",
  "dependencies": {
    "express": "^4.13.3"
  },
  "gcloudDeploy": {
    "nodeVersion": 4,
    "gcloud": {
      "projectId": "grape-spaceship-123",
      "keyFile": "~/key.json"
    },
    "vm": {
      "os": "ubuntu",
      "zone": "us-central1-b"
    }
  }
}
```

### Environment variables

  - **GCLOUD_PROJECT_ID** (required) - maps to `config.projectId`
  - **GCLOUD_KEY_FILE** - maps to `config.keyFile`
  - GCLOUD_ZONE - maps to `config.vm.zone`

With just `GCLOUD_PROJECT_ID` and `GCLOUD_KEYFILE`, you can ignore all of the other configuration options described above.

However, you are still free to provide further customization. Any values specified with the other techniques will take precedence over the environment variables.


## API

#### `gcloudDeploy = require('gcloud-deploy')([config])`

#### config
- Type: `String|Object`
- *Optional*

If a string, it is treated as the package root (`config.root`); the directory to where the project's `package.json` can be found.

If an object, See [**Configuration Object**](#config).

##### config.nodeVersion
- Type: `String`
- *Optional*
- Default: `0`

The version of Node.js to run on the deployed VM via [nvm](https://github.com/creationix/nvm). To install the latest stable version of Node.js version 4, use `config.nodeVersion = 4`.

##### config.root
- Type: `String`
- Default: `process.cwd()`

The directory to where the project's `package.json` can be found.

#### gcloudDeploy
- Type: `Stream`

A stream is returned that will **not end unless you end it**. It is a constant pouring of output from the created VM using [gce-output-stream](http://gitnpm.com/gce-output-stream). To end it, just abort the process (easy for the CLI), or programmatically:

```js
gcloudDeploy()
  .on('data', function (outputLine) {
    if (outputLine.indexOf('node server.js') > -1) {
      // Looks like the server started
      // No need to poll for more output
      this.end()
    }
  })
```

##### .on('error', function (err) {})
- Type: `Error`

An error occurred during the deploy process.

##### .on('bucket', function (bucket) {})
- Type: [`Bucket`](https://googlecloudplatform.github.io/gcloud-node/#/docs/v0.23.0/storage/bucket)

A bucket was successfully created (or re-used) to hold the tarball snapshots we take of your project.

*See the [gcloud-node Bucket docs](https://googlecloudplatform.github.io/gcloud-node/#/docs/v0.23.0/storage/bucket).*

##### .on('file', function (file) {})
- Type: [`File`](https://googlecloudplatform.github.io/gcloud-node/#/docs/v0.23.0/storage/file)

The tarball snapshot of your project was uploaded successfully. After being used by the VM's startup script, it is deleted.

*See the [gcloud-node File docs](https://googlecloudplatform.github.io/gcloud-node/#/docs/v0.23.0/storage/file).*

##### .on('vm', function (vm) {})
- Type: [`VM`](https://googlecloudplatform.github.io/gcloud-node/#/docs/v0.23.0/compute/vm)

The VM that was created to host your project. Get the name of the VM from the `name` property (`vm.name`).

*See the [gcloud-node VM docs](https://googlecloudplatform.github.io/gcloud-node/#/docs/v0.23.0/compute/vm).*

##### .on('start', function (url) {})
- Type: `String`

The URL to your project. If your app listens on port 80, you can get right to it from this URL.


## Contributions

Desperately seeking help with the following tasks:

  - Allow VMs to be re-used
  - Modularize the startup script (maybe use [this one?](https://github.com/GoogleCloudPlatform/nodejs-getting-started/blob/master/gce/startup-script.sh))
  - Don't make the tarball public
  - Expand CLI to:
    - Show running VMs
    - Stop/start VMs
    - Delete VMs

If you're interested in helping out, please open an issue so our efforts don't collide. Plus, it'd be nice to meet you!
