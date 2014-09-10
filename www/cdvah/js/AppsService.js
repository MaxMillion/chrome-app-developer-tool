/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
*/
(function() {
    'use strict';
    /* global myApp */
    myApp.factory('AppsService', ['$q', 'ResourcesLoader', 'INSTALL_DIRECTORY', 'APPS_JSON', 'AppHarnessUI', 'Reporter', function($q, ResourcesLoader, INSTALL_DIRECTORY, APPS_JSON, AppHarnessUI, Reporter) {
        // Map of type -> installer.
        var _installerFactories = Object.create(null);
        // Array of installer objects.
        var _installers = null;
        // The app that is currently running.
        var activeInstaller = null;
        var lastAccessedInstaller = null;

        function readAppsJson() {
            var deferred = $q.defer();
            ResourcesLoader.readJSONFileContents(APPS_JSON)
            .then(function(result) {
                if (result['fileVersion'] !== 1) {
                    console.warn('Ignoring old version of apps.json');
                    result = {};
                }
                deferred.resolve(result);
            }, function() {
                // Error means first run.
                deferred.resolve({});
            });
            return deferred.promise;
        }

        function initHandlers() {
            if (_installers) {
                return $q.when();
            }

            return readAppsJson()
            .then(function(json) {
                var appList = json['appList'] || [];
                _installers = [];
                var i = -1;
                return $q.when()
                .then(function next() {
                    var entry = appList[++i];
                    if (!entry) {
                        return;
                    }
                    var Ctor = _installerFactories[entry['appType']];
                    return new Ctor().initFromJson(entry)
                    .then(function(app) {
                        _installers.push(app);
                        return next();
                    }, next);
                })
                .then(function() {
                    lastAccessedInstaller = _installers.filter(function(x) { return x.appId === json['lastAccessedAppId']; })[0] || null;
                });
            });
        }

        function createAppsJson() {
            var appsJson = {
                'fileVersion': 1,
                'lastAccessedAppId': lastAccessedInstaller ? lastAccessedInstaller.appId : null,
                'appList': []
            };
            for (var i = 0; i < _installers.length; ++i) {
                var installer = _installers[i];
                appsJson.appList.push(installer.toDiskJson());
            }
            return appsJson;
        }

        function writeAppsJson() {
            if (AppsService.onAppListChange) {
                AppsService.onAppListChange();
            }
            var appsJson = createAppsJson();
            var stringContents = JSON.stringify(appsJson, null, 4);
            return ResourcesLoader.writeFileContents(APPS_JSON, stringContents);
        }

        function updateLastAccessed(app) {
            if (lastAccessedInstaller != app) {
                lastAccessedInstaller = app;
                return writeAppsJson();
            }
            return $q.when();
        }

        var AppsService = {
            // return promise with the array of apps
            getAppList : function() {
                return initHandlers()
                .then(function() {
                    return _installers.slice();
                });
            },

            getLastAccessedApp: function() {
                return lastAccessedInstaller;
            },

            getActiveApp: function() {
                return activeInstaller;
            },

            getAppListAsJson : function() {
                return createAppsJson();
            },

            // If no appId, then return the first app.
            // If appId and appType, then create it if it doesn't exist.
            // Else: return null.
            getAppById : function(appId, /* optional */ appType) {
                return initHandlers()
                .then(function() {
                    var matches = _installers;
                    if (appId) {
                        matches = _installers.filter(function(x) {
                            return x.appId == appId;
                        });
                    }
                    if (matches.length > 0) {
                        if (appType) {
                            return updateLastAccessed(matches[0])
                            .then(function() {
                                return matches[0];
                            });
                        }
                        return matches[0];
                    }
                    if (appType) {
                        return AppsService.addApp(appType, appId);
                    }
                    return null;
                });
            },

            quitApp : function() {
                if (activeInstaller) {
                    activeInstaller.unlaunch();
                    activeInstaller = null;
                    return AppHarnessUI.destroy();
                }
                return $q.when();
            },

            launchApp : function(installer) {
                return AppsService.quitApp()
                .then(function() {
                    activeInstaller = installer;
                    return updateLastAccessed(installer);
                }).then(function() {
                    return installer.launch();
                }).then(function(launchUrl) {
                    // Don't just use ResourcesLoader.doesFileExist because remaps might make it exist.
                    return ResourcesLoader.xhrGet(launchUrl)
                    .then(null, function() {
                        throw new Error('Start file does not exist: ' + launchUrl.replace(/.*?\/www\//, 'www/'));
                    }).then(function() {
                        return installer.getPluginMetadata();
                    }).then(function(pluginMetadata) {
                        return AppHarnessUI.create(launchUrl, pluginMetadata, 'crosswalk');
                    }).then(function() {
                        if (AppsService.onAppListChange) {
                            AppsService.onAppListChange();
                        }
                    }).then(function() {
                        Reporter.sendEvent('app', 'launched');
                    });
                });
            },

            addApp : function(appType, /* optional */ appId) {
                var installPath = INSTALL_DIRECTORY + 'app' + Math.floor(Math.random() * 0xFFFFFFFF).toString(36) + '/';
                return initHandlers().then(function() {
                    var Ctor = _installerFactories[appType];
                    return new Ctor().init(installPath, appId);
                }).then(function(installer) {
                    _installers.push(installer);
                    lastAccessedInstaller = installer;
                    return writeAppsJson()
                    .then(function() {
                        return installer;
                    });
                });
            },

            uninstallAllApps : function() {
                return this.quitApp()
                .then(function() {
                    var deletePromises = [];
                    for (var i = 0; i < _installers.length; ++i) {
                        deletePromises.push(AppsService.uninstallApp(_installers[i]));
                    }
                    return $q.all(deletePromises);
                });
            },

            uninstallApp : function(installer) {
                var ret = $q.when();
                if (lastAccessedInstaller == installer) {
                    lastAccessedInstaller = null;
                }
                if (installer == activeInstaller) {
                    ret = this.quitApp();
                }
                return ret.then(function() {
                    return installer.deleteFiles();
                }).then(function() {
                    _installers.splice(_installers.indexOf(installer), 1);
                    return writeAppsJson();
                });
            },

            triggerAppListChange: function() {
                return writeAppsJson();
            },

            registerInstallerFactory : function(installerFactory) {
                 _installerFactories[installerFactory.type] = installerFactory;
            },

            onAppListChange: null
        };
        return AppsService;
    }]);
})();
