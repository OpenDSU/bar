const Brick = require('./Brick');
const BrickStorageService = require('./BrickStorageService').Service;
const BrickMapController = require('./BrickMapController');
const Manifest = require("./Manifest");

/**
 * @param {ArchiveConfigurator} archiveConfigurator
 */
function Archive(archiveConfigurator) {
    const swarmutils = require("swarmutils");
    const TaskCounter = swarmutils.TaskCounter;
    const pskPth = swarmutils.path;
    const openDSU = require("opendsu");
    const anchoring = openDSU.loadAPI("anchoring");
    const anchoringx = anchoring.getAnchoringX();

    const mountedArchivesForBatchOperations = [];

    let brickMapController;
    let brickStorageService;
    let manifestHandler;
    let batchOperationsInProgress = false;
    let refreshInProgress = false;
    let refreshPromise = Promise.resolve();
    let prevAnchoringDecisionFn;
    let prevConflictResolutionFunction;

    ////////////////////////////////////////////////////////////
    // Private methods
    ////////////////////////////////////////////////////////////
    const initialize = (callback) => {
        archiveConfigurator.getKeySSI((err, keySSI) => {
            if (err) {
                return OpenDSUSafeCallback(callback)(createOpenDSUErrorWrapper("Failed to retrieve keySSI", err));
            }

            brickStorageService = buildBrickStorageServiceInstance(keySSI);
            brickMapController = new BrickMapController({
                config: archiveConfigurator,
                brickStorageService,
                keySSI,
                ...archiveConfigurator.getOptions()
            });

            callback();
        });
    }

    /**
     * Create and configure the BrickStorageService
     *
     * @param {object} storageProvider
     * @return {BrickStorageService}
     */
    function buildBrickStorageServiceInstance(keySSI) {
        const instance = new BrickStorageService({
            cache: archiveConfigurator.getCache(),
            bufferSize: archiveConfigurator.getBufferSize(),
            keySSI,

            brickFactoryFunction: (encrypt) => {
                encrypt = (typeof encrypt === 'undefined') ? true : !!encrypt;
                // Strip the encryption key from the SeedSSI
                return new Brick({templateKeySSI: keySSI, encrypt});
            },

            brickDataExtractorCallback: (brickMeta, brick, callback) => {
                brick.setTemplateKeySSI(keySSI);

                function extractData() {
                    const brickEncryptionKeySSI = brickMapController.getBrickEncryptionKeySSI(brickMeta);
                    brick.setKeySSI(brickEncryptionKeySSI);
                    brick.getRawData(callback);
                }

                if (refreshInProgress) {
                    return waitIfDSUIsRefreshing(() => {
                        extractData();
                    })
                }
                extractData();
            },

            fsAdapter: archiveConfigurator.getFsAdapter()
        });

        return instance;
    }

    const cancelBatchesInMountedArchives = (callback) => {
        const cancelBatch = (dossierContext) => {
            if (!dossierContext) {
                return callback();
            }

            dossierContext.archive.cancelBatch((err) => {
                if (err) {
                    return OpenDSUSafeCallback(callback)(createOpenDSUErrorWrapper("Failed to cancel batch operation", err));
                }

                cancelBatch(mountedArchivesForBatchOperations.pop());
            })
        }

        cancelBatch(mountedArchivesForBatchOperations.pop());
    }

    const commitBatchesInMountedArchives = (onConflict, callback) => {
        const results = [];

        const commitBatch = (dossierContext) => {
            if (!dossierContext) {
                return callback(undefined, results);
            }

            dossierContext.archive.commitBatch(onConflict, (err, result) => {
                if (err) {
                    return OpenDSUSafeCallback(callback)(createOpenDSUErrorWrapper("Failed to commit batch", err));
                }

                results.push(result);
                commitBatch(mountedArchivesForBatchOperations.pop());
            });
        }

        commitBatch(mountedArchivesForBatchOperations.pop());
    }

    /**
     * This function waits for an existing "refresh" operation to finish
     * before executing the `callback`.
     * If no refresh operation is in progress, the `callback` is executed
     * immediately.
     * This function is called by the public methods in order to prevent
     * calling methods on an uninitialized brickMapController instance
     *
     * @param {function} callback
     */
    const waitIfDSUIsRefreshing = (callback) => {
        if (refreshInProgress === false) {
            return callback();
        }

        refreshPromise.then(() => {
            callback();
        })
    }

    const getArchiveForBatchOperations = (manifestHandler, path, callback) => {
        manifestHandler.getArchiveForPath(path, (err, result) => {
            if (err) {
                return OpenDSUSafeCallback(callback)(createOpenDSUErrorWrapper(`Failed to load DSU instance mounted at path ${path}`, err));
            }

            if (result.archive === this) {
                return callback(undefined, result);
            }

            result.archive.getKeySSIAsString((err, keySSI) => {
                if (err) {
                    return OpenDSUSafeCallback(callback)(createOpenDSUErrorWrapper("Failed to retrieve keySSI", err));
                }

                const cachedArchive = mountedArchivesForBatchOperations.find((archive) => {
                    return archive.identifier === keySSI;
                });

                if (cachedArchive) {
                    cachedArchive.relativePath = result.relativePath;
                    return callback(undefined, cachedArchive);
                }

                result.identifier = keySSI;
                result.archive.beginBatch();
                mountedArchivesForBatchOperations.push(result);
                callback(undefined, result);
            });
        });
    };

    ////////////////////////////////////////////////////////////
    // Public methods
    ////////////////////////////////////////////////////////////
    /**
     * @param {callback} callback
     */
    this.init = (callback) => {
        initialize((err) => {
            if (err) {
                return OpenDSUSafeCallback(callback)(createOpenDSUErrorWrapper("Failed to initialize DSU", err));
            }

            brickMapController.init(callback);
        });
    }

    /**
     * @param {callback} callback
     */
    this.load = (callback) => {
        initialize((err) => {
            if (err) {
                return OpenDSUSafeCallback(callback)(createOpenDSUErrorWrapper("Failed to initialise DSU", err));
            }

            brickMapController.load(callback);
        });
    };

    this.hasNewVersion = (callback) => {
        this.getLatestAnchoredHashLink((err, latestAnchoredHashLink) => {
            if (err) {
                return callback(err);
            }
            let latestAnchor = latestAnchoredHashLink ? latestAnchoredHashLink.getIdentifier() : "UNDEFINED1";
            let fromNetwork = this.getAnchoringStrategy().getCurrentHashLink();
            fromNetwork = fromNetwork ? fromNetwork.getIdentifier() : " UNDEFINED2";
            return callback(undefined, fromNetwork !== latestAnchor);
        })
    }

    this.loadVersion = (versionHash, callback) => {
        initialize((err) => {
            if (err) {
                return OpenDSUSafeCallback(callback)(createOpenDSUErrorWrapper("Failed to initialise DSU", err));
            }
            brickMapController.loadVersion(versionHash, callback);
        });
    };

    this.getBrickMapController = () => {
        return brickMapController;
    }
    /**
     * @param {callback} callback
     */
    this.refresh = (callback) => {
        this.getLatestAnchoredHashLink((err, latestAnchoredHashlink) => {
            if (err || !latestAnchoredHashlink) {
                return callback()
            }

            waitIfDSUIsRefreshing(() => {
                refreshInProgress = true;
                refreshPromise = refreshPromise.then(() => {
                    return new Promise((resolve) => {
                        this.load((err) => {
                            if (err) {
                                refreshInProgress = false;
                                return resolve(OpenDSUSafeCallback(callback)(createOpenDSUErrorWrapper("Failed to load DSU", err)));
                            }

                            resolve(callback());
                        });
                    }).catch(() => {
                        console.trace("This shouldn't happen. Refresh errors should have been already caught");
                    })
                })
            });
        })
    }

    /**
     * Returns the latest anchor
     *
     * @param {callback} function
     * @return {HashLinkSSI}
     */
    this.getLastHashLinkSSI = (callback) => {
        console.log("This method is obsolete. Please use `dsu.getLatestAnchoredHashLink()` instead.");
        return this.getLatestAnchoredHashLink(callback);
    };

    /**
     * Returns the latest anchored Hashlink
     *
     * @param {callback} function
     * @return {HashLinkSSI}
     */
    this.getLatestAnchoredHashLink = (callback) => {
        archiveConfigurator.getKeySSI((err, keySSI) => {
            if (err) {
                return callback(createOpenDSUErrorWrapper("Failed to get KeySSI", err));
            }
            anchoringx.getLastVersion(keySSI, (err, latestHashLink) => {
                if (err || !latestHashLink) {
                    return callback(createOpenDSUErrorWrapper("Failed to get the list of hashlinks", err));
                }

                const keySSISpace = require("opendsu").loadAPI("keyssi");
                if (typeof latestHashLink === "string") {
                    try {
                        latestHashLink = keySSISpace.parse(latestHashLink);
                    } catch (e) {
                        return callback(createOpenDSUErrorWrapper("Failed to get the list of hashlinks", e));
                    }
                }
                return callback(undefined, latestHashLink)
            })
        })
    }

    /**
     * Returns the current anchor
     *
     * @return {HashLinkSSI}
     */
    this.getCurrentAnchoredHashLink = (callback) => {
        return waitIfDSUIsRefreshing(() => {
            return callback(undefined, brickMapController.getCurrentAnchoredHashLink());
        })
    }

    /**
     * @return {string}
     */
    this.getKeySSI = (keySSIType, callback) => {
        console.trace("Obsolete function: use getKeySSIAsString or getKeySSIAsObject Instead");
        if (typeof keySSIType === "function") {
            callback = keySSIType;
            keySSIType = undefined;
        }
        return archiveConfigurator.getKeySSI(keySSIType, ((err, keySSI) => callback(err, keySSI.getIdentifier())));
    }

    /**
     * @return {string}
     */
    this.getKeySSIAsObject = (keySSIType, callback) => {
        if (typeof keySSIType === "function") {
            callback = keySSIType;
            keySSIType = undefined;
        }
        archiveConfigurator.getKeySSI(keySSIType, callback);
    }

    this.getKeySSIAsObjectSync = () => {
        return archiveConfigurator.getKeySSISync();
    }
    /**
     * @return {string}
     */
    this.getKeySSIAsString = (keySSIType, callback) => {
        if (typeof keySSIType === "function") {
            callback = keySSIType;
            keySSIType = undefined;
        }
        archiveConfigurator.getKeySSI(keySSIType, ((err, keySSI) => callback(err, keySSI.getIdentifier())));
    }

    this.getKeySSIAsStringSync = () => {
        return this.getKeySSIAsObjectSync().getIdentifier();
    }

    /**
     * @return {string}
     */
    this.getCreationSSI = (plain) => {
        return archiveConfigurator.getCreationSSI(plain);
    }

    this.getUniqueIdAsync = async () => {
        let keySSI = await $$.promisify(this.getKeySSIAsObject)();
        return await keySSI.getAnchorIdAsync();
    }

    this.getAnchorIdSync = () => {
        return this.getKeySSIAsObjectSync().getAnchorIdSync();
    }

    /**
     * @return {string}
     */
    this.getAnchorId = (callback) => {
        this.getKeySSIAsObject((err, keySSIInstance) => {
            if (err) {
                return callback(createOpenDSUErrorWrapper(`Failed to get keySSI`, err));
            }

            keySSIInstance.getAnchorId(callback);
        });
    }

    const _fileIsEmbedded = (barPath, callback) => {
        brickMapController.fileIsEmbedded(barPath, callback);
    };

    const _ingestData = (barPath, data, options, callback) => {
        brickStorageService.ingestData(data, options, callback)
    }

    const _embedFile = (barPath, data, options, callback) => {
        brickStorageService.createEmbedSSIFromData(data, options, (err, result) => {
            if (err) {
                return callback(createOpenDSUErrorWrapper(`Failed to embed file ${barPath}`, err));
            }

            brickMapController.addFile(barPath, result, callback);
        })
    }

    /**
     * @param {string} barPath
     * @param {string|$$.Buffer|stream.ReadableStream} data
     * @param {object} options
     * @param {callback} callback
     */
    const _writeFile = (barPath, data, options, callback) => {
        barPath = pskPth.normalize(barPath);

        if (typeof data === "undefined") {
            return _createFile(barPath, callback);
        }

        if (options.embed) {
            return brickMapController.embedData(barPath, data, options, callback);
        }

        _fileIsEmbedded(barPath, (err, fileIsEmbedded) => {
            if (err) {
                return callback(err);
            }

            if (fileIsEmbedded) {
                return brickMapController.embedData(barPath, data, options, callback);
            }

            _ingestData(barPath, data, options, (err, result) => {
                if (err) {
                    return callback(err);
                }
                brickMapController.addFile(barPath, result, callback);

            });
        });
    };

    const _appendToFile = (barPath, data, options, callback) => {
        barPath = pskPth.normalize(barPath);

        if (options.embed) {
            return brickMapController.appendToEmbeddedFile(barPath, data, options, callback);
        }

        _fileIsEmbedded(barPath, (err, fileIsEmbedded) => {
            if (err) {
                return callback(err);
            }

            if (fileIsEmbedded) {
                return brickMapController.appendToEmbeddedFile(barPath, data, options, callback);
            }

            _ingestData(barPath, data, options, (err, result) => {
                if (err) {
                    return callback(err);
                }

                brickMapController.appendToFile(barPath, result, callback);
            });
        });
    };

    /**
     * @param {string} barPath
     * @param {object[]} bricks
     * @param {callback} callback
     */
    const _writeFileFromBricks = (barPath, bricks, callback) => {
        barPath = pskPth.normalize(barPath);
        brickMapController.addFile(barPath, bricks, callback);
    };

    /**
     * @param {sizeSSI} sizeSSI
     */
    const _isAvailableSpaceInLastBrick = (sizeSSI) => {
        if (typeof sizeSSI === "string") {
            const keySSISpace = require("opendsu").loadAPI("keyssi");
            sizeSSI = keySSISpace.parse(sizeSSI);
        }
        const totalSize = sizeSSI.getTotalSize();
        const bufferSize = sizeSSI.getBufferSize();
        return totalSize % bufferSize !== 0;
    };

    /**
     * @param {string} barPath
     * @param {object} newSizeSSI
     * @param {object} brick
     * @param {callback} callback
     */
    const _appendBigFileBrick = (barPath, newSizeSSI, brick, callback) => {
        _getBigFileBricksMeta(barPath, (error, bricksMeta) => {
            if (error) {
                return callback(error);
            }

            if (!_isSizeSSIPresentInBricksMetaAndIsValid(bricksMeta)) {
                return OpenDSUSafeCallback(callback)(createOpenDSUErrorWrapper(`Provided path ${barPath} is not a BigFile`));
            }

            // check using the current sizeSSI if there is available space inside the last brick
            if (_isAvailableSpaceInLastBrick(bricksMeta[0].size)) {
                return brickMapController.updateBigFileLastBrick(barPath, newSizeSSI, brick, callback);
            }
            return brickMapController.appendBigFile(barPath, newSizeSSI, brick, callback);
        });
    };

    /**
     * @param {string} barPath
     * @param {callback} callback
     */
    const _getBigFileBricksMeta = (barPath, callback) => {
        barPath = pskPth.normalize(barPath);
        try {
            const bricksMeta = brickMapController.getBricksMeta(barPath);
            callback(null, bricksMeta);
        } catch (err) {
            return OpenDSUSafeCallback(callback)(createOpenDSUErrorWrapper("Failed to find any info for path " + barPath, err));
        }
    };

    /**
     * @param {object} bricksMeta
     */
    const _isSizeSSIPresentInBricksMeta = (bricksMeta) => {
        return !!bricksMeta && !!bricksMeta[0] && !!bricksMeta[0].size;
    }

    const _isSizeSSIValid = (sizeSSI) => {
        try {
            const keySSISpace = require("opendsu").loadAPI("keyssi");
            keySSISpace.parse(sizeSSI);
            return true;
        } catch (error) {
            return false;
        }
    }

    const _isSizeSSIPresentInBricksMetaAndIsValid = (bricksMeta) => {
        if (!_isSizeSSIPresentInBricksMeta(bricksMeta)) {
            return false;
        }

        return _isSizeSSIValid(bricksMeta[0].size);
    }

    /**
     * @param {string} barPath
     * @param {callback} callback
     */
    const _readFile = (barPath, callback) => {
        barPath = pskPth.normalize(barPath);

        let bricksMeta;
        let embeddedData;
        try {
            embeddedData = brickMapController.getEmbeddedFile(barPath);
        } catch (e) {
            return callback(e);
        }

        if (typeof embeddedData !== "undefined") {
            return callback(undefined, embeddedData);
        }

        try {
            bricksMeta = brickMapController.getBricksMeta(barPath);
        } catch (err) {
            return OpenDSUSafeCallback(callback)(createOpenDSUErrorWrapper("Failed to find any info for path " + barPath + " in brickmap", err));
        }

        if (_isSizeSSIPresentInBricksMeta(bricksMeta)) {
            return OpenDSUSafeCallback(callback)(createOpenDSUErrorWrapper(`Failed to read big file as normal file for path ${barPath}`));
        }

        brickStorageService.createBufferFromBricks(bricksMeta, (err, buffer) => {
            if (err) {
                return OpenDSUSafeCallback(callback)(createOpenDSUErrorWrapper("Failed to create buffer from bricks", err));
            }

            callback(undefined, buffer);
        });
    };

    /**
     * @param {string} barPath
     * @param {callback} callback
     */
    const _createReadStream = (barPath, callback) => {
        barPath = pskPth.normalize(barPath);

        let bricksMeta;
        try {
            bricksMeta = brickMapController.getBricksMeta(barPath);
        } catch (err) {
            return OpenDSUSafeCallback(callback)(createOpenDSUErrorWrapper("Failed to find any info for path " + barPath, err));
        }

        if (_isSizeSSIPresentInBricksMeta(bricksMeta)) {
            return OpenDSUSafeCallback(callback)(createOpenDSUErrorWrapper(`Failed to read big file as normal file for path ${barPath}`));
        }

        brickStorageService.createStreamFromBricks(bricksMeta, (err, stream) => {
            if (err) {
                return OpenDSUSafeCallback(callback)(createOpenDSUErrorWrapper("Failed to create stream from bricks", err));
            }

            callback(undefined, stream);
        });
    };

    /**
     * @param {string} barPath
     * @param {callback} callback
     */
    const _createBigFileReadStreamWithRange = (barPath, range, callback) => {
        barPath = pskPth.normalize(barPath);

        let bricksMeta;
        try {
            bricksMeta = brickMapController.getBricksMeta(barPath);
        } catch (err) {
            return OpenDSUSafeCallback(callback)(createOpenDSUErrorWrapper("Failed to find any info for path " + barPath, err));
        }

        if (!bricksMeta || !bricksMeta.length) {
            return OpenDSUSafeCallback(callback)(createOpenDSUErrorWrapper("Failed to find any info for path " + barPath));
        }

        if (!bricksMeta[0].size) {
            return OpenDSUSafeCallback(callback)(createOpenDSUErrorWrapper(`Cannot stream path ${barPath} since it's not a BigFile`));
        }

        let sizeSSI;
        try {
            const keySSISpace = require("opendsu").loadAPI("keyssi");
            sizeSSI = keySSISpace.parse(bricksMeta[0].size);
        } catch (e) {
            return OpenDSUSafeCallback(callback)(createOpenDSUErrorWrapper(`The provided keyssi is not a valid SSI string.`, e));
        }

        let canCreateStream = !!sizeSSI && !!sizeSSI.isSizeSSI && sizeSSI.isSizeSSI();
        if (!canCreateStream) {
            return OpenDSUSafeCallback(callback)(createOpenDSUErrorWrapper(`Cannot stream path ${barPath} since it's not a BigFile`));
        }

        bricksMeta = bricksMeta.slice(1); // remove SizeSSI from bricksMeta
        brickStorageService.createStreamFromBricksWithRange(sizeSSI, bricksMeta, range, (err, stream) => {
            if (err) {
                return OpenDSUSafeCallback(callback)(createOpenDSUErrorWrapper("Failed to create stream from bricks", err));
            }

            callback(undefined, {totalSize: sizeSSI.getTotalSize(), stream});
        });
    };

    /**
     * @param {string} fsFilePath
     * @param {string} barPath
     * @param {object} options
     * @param {callback} callback
     */
    const _addFile = (fsFilePath, barPath, options, callback) => {
        if (typeof options === "function") {
            callback = options;
            options = {
                encrypt: true
            }
        }

        barPath = pskPth.normalize(barPath);

        brickStorageService.ingestFile(fsFilePath, options, (err, result) => {
            if (err) {
                return OpenDSUSafeCallback(callback)(createOpenDSUErrorWrapper("Failed to ingest data into bricks storage", err));
            }

            brickMapController.addFile(barPath, result, callback);
        })
    };

    /**
     * @param {string} files
     * @param {string} barPath
     * @param {object} options
     * @param {callback} callback
     */
    const _addFiles = (files, barPath, options, callback) => {
        if (typeof options === "function") {
            callback = options;
            options = {
                encrypt: true,
                embedded: false
            };
        }

        barPath = pskPth.normalize(barPath);

        const filesArray = files.slice();

        const ingestionMethod = (!options.embedded) ? 'ingestFiles' : 'createBrickFromFiles';

        brickStorageService[ingestionMethod](filesArray, options, (err, result) => {
            if (err) {
                return OpenDSUSafeCallback(callback)(createOpenDSUErrorWrapper("Failed to add files at path " + barPath, err));
            }

            brickMapController.addFiles(barPath, result, callback);
        });
    };

    this.addFiles = (files, barPath, options, callback) => {
        waitIfDSUIsRefreshing(() => {
            if (typeof options === "function") {
                callback = options;
                options = {
                    encrypt: true,
                    ignoreMounts: false,
                    embedded: false
                };
            }

            if (options.ignoreMounts === true) {
                _addFiles(files, barPath, options, callback);
            } else {
                this.getArchiveForPath(barPath, (err, dossierContext) => {
                    if (err) {
                        return OpenDSUSafeCallback(callback)(createOpenDSUErrorWrapper(`Failed to load DSU instance mounted at path ${barPath}`, err));
                    }

                    options.ignoreMounts = true;
                    dossierContext.archive.addFiles(files, dossierContext.relativePath, options, callback);
                });
            }
        })
    }

    /**
     * @param {string} fsFilePath
     * @param {string} barPath
     * @param {callback} callback
     */
    const _extractFile = (fsFilePath, barPath, callback) => {
        if (typeof barPath === "function") {
            callback = barPath;
            barPath = pskPth.normalize(fsFilePath);
        }

        let bricksMeta;

        try {
            bricksMeta = brickMapController.getBricksMeta(barPath);
        } catch (err) {
            return OpenDSUSafeCallback(callback)(createOpenDSUErrorWrapper("Failed to any information for path " + barPath, err));
        }


        brickStorageService.createFileFromBricks(fsFilePath, bricksMeta, callback);
    };

    /**
     * @param {string} barPath
     * @param {string|$$.Buffer|stream.ReadableStream} data
     * @param {callback} callback
     */
    this.appendToFile = (barPath, data, options, callback) => {
        waitIfDSUIsRefreshing(() => {
            const defaultOpts = {encrypt: true, ignoreMounts: false};
            if (typeof options === "function") {
                callback = options;
                options = {};
            }

            Object.assign(defaultOpts, options);
            options = defaultOpts;

            if (options.ignoreMounts) {
                barPath = pskPth.normalize(barPath);
                _appendToFile(barPath, data, options, callback);
            } else {
                this.getArchiveForPath(barPath, (err, dossierContext) => {
                    if (err) {
                        return OpenDSUSafeCallback(callback)(createOpenDSUErrorWrapper(`Failed to load DSU instance mounted at path ${barPath}`, err));
                    }
                    if (dossierContext.readonly === true) {
                        return callback(Error("Tried to write in a readonly mounted RawDossier"));
                    }

                    options.ignoreMounts = true;
                    dossierContext.archive.appendToFile(dossierContext.relativePath, data, options, callback);
                });
            }
        })
    };


    this.dsuLog = (message, callback) => {
        waitIfDSUIsRefreshing(() => {
            this.appendToFile("/dsu-metadata-log", message + "\n", {ignoreMissing: true}, callback);
        })
    }
    /**
     * @param {string} fsFolderPath
     * @param {string} barPath
     * @param {object} options
     * @param {callback} callback
     */
    const _addFolder = (fsFolderPath, barPath, options, callback) => {
        if (typeof options === "function") {
            callback = options;
            options = {
                encrypt: true,
                embedded: false
            };
        }
        barPath = pskPth.normalize(barPath);

        const ingestionMethod = (!options.embedded) ? 'ingestFolder' : 'createBrickFromFolder';

        brickStorageService[ingestionMethod](fsFolderPath, options, (err, result) => {
            if (err) {
                return OpenDSUSafeCallback(callback)(createOpenDSUErrorWrapper(`Failed to add folder ${fsFolderPath} to  ${barPath}`, err));
            }

            brickMapController.addFiles(barPath, result, callback);
        });
    };

    /**
     * @param {string} fsFolderPath
     * @param {string} barPath
     * @param {callback} callback
     */
    const _extractFolder = (fsFolderPath, barPath, callback) => {
        if (typeof barPath === "function") {
            callback = barPath;
            barPath = pskPth.normalize(fsFolderPath);
        }

        const filePaths = brickMapController.getFileList(barPath);
        const taskCounter = new TaskCounter(() => {
            callback();
        });
        taskCounter.increment(filePaths.length);
        filePaths.forEach(filePath => {
            let actualPath;
            if (fsFolderPath) {
                if (fsFolderPath.includes(filePath)) {
                    actualPath = fsFolderPath;
                } else {
                    actualPath = require("path").join(fsFolderPath, filePath);
                }
            } else {
                actualPath = filePath;
            }

            this.extractFile(actualPath, filePath, (err) => {
                if (err) {
                    return OpenDSUSafeCallback(callback)(createOpenDSUErrorWrapper(`Failed to extract file ${actualPath} to ${filePath}`, err));
                }

                taskCounter.decrement();
            });
        });
    };

    /**
     * @param {string} barPath
     * @param {callback} callback
     */
    const _delete = (barPath, callback) => {
        brickMapController.deleteFile(barPath, callback);
        //this resets the state in case a folder gets removed and under the same path are other dsu mounted.
        manifestHandler = undefined;
    };

    /**
     * @param {string} srcPath
     * @param {dstPath} dstPath
     */

    const _rename = (srcPath, dstPath, callback) => {
        srcPath = pskPth.normalize(srcPath);
        dstPath = pskPth.normalize(dstPath);

        brickMapController.renameFile(srcPath, dstPath, callback);
    }

    /**
     * @param {string} folderBarPath
     * @param {object} options
     * @param {function} callback
     */
    const _listFiles = (folderBarPath, options, callback) => {
        if (typeof options === "function") {
            callback = options;
            options = {recursive: true};
        } else if (typeof folderBarPath === "function") {
            callback = folderBarPath;
            options = {recursive: true};
            folderBarPath = "/";
        }

        let fileList;
        let error;
        try {
            fileList = brickMapController.getFileList(folderBarPath, options.recursive);
        } catch (e) {
            error = e;
        }

        setTimeout(() => {
            callback(error, fileList);
        }, 0)
    };

    const _listMountedFiles = (mountPoints, result, callback) => {
        if (typeof result === 'function') {
            callback = result;
            result = [];
        }
        let mountPoint = mountPoints.shift();

        if (!mountPoint) {
            return callback(undefined, result)
        }

        mountPoint = pskPth.normalize(mountPoint);

        this.listFiles(mountPoint, {
            recursive: true,
            ignoreMounts: false
        }, (err, files) => {
            if (err) {
                return OpenDSUSafeCallback(callback)(createOpenDSUErrorWrapper(`Failed to list files at path ${mountPoint}`, err));
            }

            result.push(files.map((file) => {
                let prefix = mountPoint;
                if (prefix[0] === '/') {
                    prefix = prefix.substring(1);
                }

                return pskPth.normalize(`${prefix}/${file}`);
            }));

            _listMountedFiles(mountPoints, result, callback);
        });
    };

    /**
     * @param {string} folderBarPath
     * @param {object} options
     * @param {boolean} options.recursive
     * @param {callback} callback
     */
    const _listFolders = (folderBarPath, options, callback) => {
        if (typeof options === "function") {
            callback = options;
            options = {recursive: true};
        }

        callback(undefined, brickMapController.getFolderList(folderBarPath, options.recursive));
    };

    const _listMountedFolders = (mountPoints, result, callback) => {
        if (typeof result === 'function') {
            callback = result;
            result = [];
        }

        let mountPoint = mountPoints.shift();
        if (!mountPoint) {
            return callback(undefined, result);
        }

        mountPoint = pskPth.normalize(mountPoint);

        this.listFolders(mountPoint, {
            recursive: true,
            ignoreMounts: false
        }, (err, folders) => {
            if (err) {
                return OpenDSUSafeCallback(callback)(createOpenDSUErrorWrapper(`Failed to list mounted folders at path ${mountPoint}`, err));
            }

            result.push((folders.map((folder) => {
                let prefix = mountPoint;
                if (prefix[0] === '/') {
                    prefix = prefix.substring(1);
                }

                return pskPth.normalize(`${prefix}/${folder}`);
            })));

            _listMountedFolders(mountPoints, result, callback);
        })
    };

    /**
     * @param {string} barPath
     * @param {callback} callback
     */
    const _createFolder = (barPath, callback) => {
        brickMapController.createDirectory(barPath, callback);
    };

    const _createFile = (barPath, callback) => {
        brickMapController.createEmptyFile(barPath, callback);
    };

    /**
     * @param {object} rules
     * @param {object} rules.preWrite
     * @param {object} rules.afterLoad
     */
    this.setValidationRules = (rules) => {
        brickMapController.setValidationRules(rules);
    }

    /**
     * @param {callback} listener
     */
    this.setAnchoringEventListener = (listener) => {
        this.getAnchoringStrategy().setAnchoringEventListener(listener);
    }

    /**
     * @param {callback} callback
     */
    this.setDecisionCallback = (callback) => {
        this.getAnchoringStrategy().setDecisionCallback(callback);
    }

    /**
     * @return {AnchoringStrategy}
     */
    this.getAnchoringStrategy = () => {
        return archiveConfigurator.getBrickMapStrategy();
    }

    /**
     * Manually anchor any changes
     */
    this.doAnchoring = (callback) => {
        const strategy = this.getAnchoringStrategy();
        let alreadyCalled = false;
        let saneCallback = function (err) {
            if (alreadyCalled) {
                throw Error("Already called");
            }

            if (err) {
                return callback(err);
            }

            return callback();
        }
        const anchoringEventListener = strategy.getAnchoringEventListener() || saneCallback;
        if (typeof anchoringEventListener !== 'function') {
            throw new Error('An anchoring event listener is required');
        }

        brickMapController.anchorChanges(anchoringEventListener);
    }

    const getManifest = (callback) => {
        let options = archiveConfigurator.getOptions();
        const defaultOptions = {skipCache: archiveConfigurator.dsuCachingEnabled()};
        options = Object.assign(defaultOptions, options);
        if (typeof manifestHandler === "undefined") {
            Manifest.getManifest(this, options, (err, handler) => {
                if (err) {
                    return OpenDSUSafeCallback(callback)(createOpenDSUErrorWrapper(`Failed to get manifest handler`, err));
                }

                manifestHandler = handler;
                return callback(undefined, manifestHandler);
            });
        } else {
            return callback(undefined, manifestHandler);
        }
    }

    this.getSSIForMount = (mountPoint, callback) => {
        getManifest((err, manifestHandler) => {
            if (err) {
                return OpenDSUSafeCallback(callback)(createOpenDSUErrorWrapper("Failed to load manifest for " + mountPoint, err));
            }
            manifestHandler.getArchiveIdentifier(mountPoint, callback);
        });
    }

    this.addFolder = (fsFolderPath, barPath, options, callback) => {
        waitIfDSUIsRefreshing(() => {
            const defaultOpts = {encrypt: true, ignoreMounts: false, embedded: false};
            if (typeof options === "function") {
                callback = options;
                options = {};
            }
            callback = $$.makeSaneCallback(callback);
            Object.assign(defaultOpts, options);
            options = defaultOpts;


            if (options.ignoreMounts === true) {
                _addFolder(fsFolderPath, barPath, options, callback);
            } else {
                this.getArchiveForPath(barPath, (err, result) => {
                    if (err) {
                        return OpenDSUSafeCallback(callback)(createOpenDSUErrorWrapper(`Failed to load DSU instance mounted at path ${barPath}`, err));
                    }

                    options.ignoreMounts = true;
                    result.archive.addFolder(fsFolderPath, result.relativePath, options, callback);
                });
            }

        })
    };

    this.addFile = (fsFilePath, barPath, options, callback) => {
        waitIfDSUIsRefreshing(() => {
            const defaultOpts = {encrypt: true, ignoreMounts: false};
            if (typeof options === "function") {
                callback = options;
                options = {};
            }

            callback = $$.makeSaneCallback(callback);
            Object.assign(defaultOpts, options);
            options = defaultOpts;

            if (options.ignoreMounts === true) {
                _addFile(fsFilePath, barPath, options, callback);
            } else {
                this.getArchiveForPath(barPath, (err, result) => {
                    if (err) {
                        return OpenDSUSafeCallback(callback)(createOpenDSUErrorWrapper(`Failed to load DSU instance mounted at path ${barPath}`, err));
                    }

                    options.ignoreMounts = true;
                    result.archive.addFile(fsFilePath, result.relativePath, options, callback);
                });
            }
        })
    };

    this.readFile = (fileBarPath, options, callback) => {
        waitIfDSUIsRefreshing(() => {
            const defaultOpts = {ignoreMounts: false};
            if (typeof options === "function") {
                callback = options;
                options = {};
            }

            callback = $$.makeSaneCallback(callback);
            Object.assign(defaultOpts, options);
            options = defaultOpts;
            if (options.ignoreMounts === true) {
                _readFile(fileBarPath, callback);
            } else {
                this.getArchiveForPath(fileBarPath, (err, result) => {
                    if (err) {
                        return OpenDSUSafeCallback(callback)(createOpenDSUErrorWrapper(`Failed to load DSU instance mounted at path ${fileBarPath}`, err));
                    }

                    options.ignoreMounts = true
                    result.archive.readFile(result.relativePath, options, callback);
                });
            }
        })
    };

    this.createReadStream = (fileBarPath, options, callback) => {
        waitIfDSUIsRefreshing(() => {
            const defaultOpts = {encrypt: true, ignoreMounts: false};
            if (typeof options === "function") {
                callback = options;
                options = {};
            }

            callback = $$.makeSaneCallback(callback);
            Object.assign(defaultOpts, options);
            options = defaultOpts;
            if (options.ignoreMounts === true) {
                _createReadStream(fileBarPath, callback);
            } else {
                this.getArchiveForPath(fileBarPath, (err, result) => {
                    if (err) {
                        return OpenDSUSafeCallback(callback)(createOpenDSUErrorWrapper(`Failed to load DSU instance mounted at path ${fileBarPath}`, err));
                    }

                    options.ignoreMounts = true;
                    result.archive.createReadStream(result.relativePath, options, callback);
                });
            }
        })
    };

    this.createBigFileReadStreamWithRange = (fileBarPath, range, options, callback) => {
        waitIfDSUIsRefreshing(() => {
            const defaultOpts = {encrypt: true, ignoreMounts: false};
            if (typeof options === "function") {
                callback = options;
                options = {};
            }
            if (typeof range === "function") {
                callback = range;
                range = {start: 0};
                options = {};
            }

            callback = $$.makeSaneCallback(callback);
            Object.assign(defaultOpts, options);
            options = defaultOpts;
            if (options.ignoreMounts === true) {
                _createBigFileReadStreamWithRange(fileBarPath, range, callback);
            } else {
                this.getArchiveForPath(fileBarPath, (err, result) => {
                    if (err) {
                        return OpenDSUSafeCallback(callback)(createOpenDSUErrorWrapper(`Failed to load DSU instance mounted at path ${fileBarPath}`, err));
                    }

                    options.ignoreMounts = true;
                    result.archive.createBigFileReadStreamWithRange(result.relativePath, range, options, callback);
                });
            }
        })
    };

    this.extractFolder = (fsFolderPath, barPath, options, callback) => {
        waitIfDSUIsRefreshing(() => {
            const defaultOpts = {ignoreMounts: false};
            if (typeof options === "function") {
                callback = options;
                options = {};
            }

            callback = $$.makeSaneCallback(callback);
            Object.assign(defaultOpts, options);
            options = defaultOpts;
            if (options.ignoreMounts === true) {
                _extractFolder(fsFolderPath, barPath, callback);
            } else {
                this.getArchiveForPath(barPath, (err, result) => {
                    if (err) {
                        return OpenDSUSafeCallback(callback)(createOpenDSUErrorWrapper(`Failed to load DSU instance mounted at path ${barPath}`, err));
                    }

                    options.ignoreMounts = true;
                    result.archive.extractFolder(fsFolderPath, result.relativePath, options, callback);
                });
            }
        })
    };

    this.extractFile = (fsFilePath, barPath, options, callback) => {
        waitIfDSUIsRefreshing(() => {
            const defaultOpts = {ignoreMounts: false};
            if (typeof options === "function") {
                callback = options;
                options = {};
            }

            callback = $$.makeSaneCallback(callback);
            Object.assign(defaultOpts, options);
            options = defaultOpts;

            if (options.ignoreMounts === true) {
                _extractFile(fsFilePath, barPath, callback);
            } else {
                this.getArchiveForPath(barPath, (err, result) => {
                    if (err) {
                        return OpenDSUSafeCallback(callback)(createOpenDSUErrorWrapper(`Failed to load DSU instance mounted at path ${barPath}`, err));
                    }

                    options.ignoreMounts = true;
                    result.archive.extractFile(fsFilePath, result.relativePath, options, callback);
                });
            }
        })
    };

    this.writeFile = (path, data, options, callback) => {
        waitIfDSUIsRefreshing(() => {
            const defaultOpts = {encrypt: true, ignoreMounts: false, embed: false};
            if (typeof data === "function") {
                callback = data;
                data = undefined;
                options = undefined;
            }
            if (typeof options === "function") {
                callback = options;
                options = defaultOpts;
            }
            if (typeof options === "undefined") {
                options = defaultOpts;
            }

            callback = $$.makeSaneCallback(callback);

            Object.assign(defaultOpts, options);
            options = defaultOpts;
            if (options.embed) {
                options.encrypt = false;
            }

            if (options.ignoreMounts === true) {
                _writeFile(path, data, options, callback);
            } else {
                this.getArchiveForPath(path, (err, dossierContext) => {
                    if (err) {
                        return OpenDSUSafeCallback(callback)(createOpenDSUErrorWrapper(`Failed to load DSU instance mounted at path ${path}`, err));
                    }
                    if (dossierContext.readonly === true) {
                        return callback(Error("Tried to write in a readonly mounted RawDossier"));
                    }

                    options.ignoreMounts = true;
                    dossierContext.archive.writeFile(dossierContext.relativePath, data, options, callback);
                });
            }
        })
    };

    this.embedFile = (path, data, options, callback) => {
        waitIfDSUIsRefreshing(() => {
            const defaultOpts = {encrypt: true, ignoreMounts: false};
            if (typeof data === "function") {
                callback = data;
                data = undefined;
                options = undefined;
            }
            if (typeof options === "function") {
                callback = options;
                options = {
                    encrypt: true
                };
            }
            if (typeof options === "undefined") {
                options = {
                    encrypt: true
                };
            }

            callback = $$.makeSaneCallback(callback);

            Object.assign(defaultOpts, options);
            options = defaultOpts;

            if (options.ignoreMounts === true) {
                _embedFile(path, data, options, callback);
            } else {
                this.getArchiveForPath(path, (err, dossierContext) => {
                    if (err) {
                        return OpenDSUSafeCallback(callback)(createOpenDSUErrorWrapper(`Failed to load DSU instance mounted at path ${path}`, err));
                    }
                    if (dossierContext.readonly === true) {
                        return callback(Error("Tried to write in a readonly mounted RawDossier"));
                    }

                    options.ignoreMounts = true;
                    dossierContext.archive.embedFile(dossierContext.relativePath, data, options, callback);
                });
            }
        })
    };

    this.writeFileFromBricks = (path, bricks, options, callback) => {
        waitIfDSUIsRefreshing(() => {
            const defaultOpts = {ignoreMounts: false};
            if (typeof options === "function") {
                callback = options;
                options = {};
            }
            if (typeof options === "undefined") {
                options = {};
            }

            callback = $$.makeSaneCallback(callback);
            if (typeof path !== "string") {
                return OpenDSUSafeCallback(callback)(createOpenDSUErrorWrapper("Provided path for writeFileFromBricks must be a string"));
            }
            if (!Array.isArray(bricks) || !_isSizeSSIPresentInBricksMetaAndIsValid(bricks)) {
                return OpenDSUSafeCallback(callback)(createOpenDSUErrorWrapper("Provided bricks for writeFileFromBricks must be an array of a single sizeSSI and multiple hashlinks"));
            }

            Object.assign(defaultOpts, options);
            options = defaultOpts;

            if (options.ignoreMounts === true) {
                _writeFileFromBricks(path, bricks, callback);
            } else {
                this.getArchiveForPath(path, (err, dossierContext) => {
                    if (err) {
                        return OpenDSUSafeCallback(callback)(createOpenDSUErrorWrapper(`Failed to load DSU instance mounted at path ${path}`, err));
                    }
                    if (dossierContext.readonly === true) {
                        return callback(Error("Tried to write in a readonly mounted RawDossier"));
                    }

                    options.ignoreMounts = true;
                    dossierContext.archive.writeFileFromBricks(dossierContext.relativePath, bricks, options, callback);
                });
            }
        });
    }

    this.appendBigFileBrick = (path, newSizeSSI, brick, options, callback) => {
        waitIfDSUIsRefreshing(() => {
            const defaultOpts = {ignoreMounts: false};
            if (typeof options === "function") {
                callback = options;
                options = {};
            }
            if (typeof options === "undefined") {
                options = {};
            }

            callback = $$.makeSaneCallback(callback);
            if (typeof path !== "string") {
                return OpenDSUSafeCallback(callback)(createOpenDSUErrorWrapper("Provided path for appendBigFileBrick must be a string"));
            }
            if (!newSizeSSI || !_isSizeSSIValid(newSizeSSI)) {
                return OpenDSUSafeCallback(callback)(createOpenDSUErrorWrapper("Provided newSizeSSI is not a valid sizeSSI"));
            }

            Object.assign(defaultOpts, options);
            options = defaultOpts;

            if (options.ignoreMounts === true) {
                _appendBigFileBrick(path, newSizeSSI, brick, callback);
            } else {
                this.getArchiveForPath(path, (err, dossierContext) => {
                    if (err) {
                        return OpenDSUSafeCallback(callback)(createOpenDSUErrorWrapper(`Failed to load DSU instance mounted at path ${path}`, err));
                    }
                    if (dossierContext.readonly === true) {
                        return callback(Error("Tried to write in a readonly mounted RawDossier"));
                    }

                    options.ignoreMounts = true;
                    dossierContext.archive.appendBigFileBrick(dossierContext.relativePath, newSizeSSI, brick, options, callback);
                });
            }
        });
    }

    this.getBigFileBricksMeta = (path, options, callback) => {
        waitIfDSUIsRefreshing(() => {
            const defaultOpts = {ignoreMounts: false};
            if (typeof options === "function") {
                callback = options;
                options = {};
            }
            if (typeof options === "undefined") {
                options = {};
            }

            callback = $$.makeSaneCallback(callback);
            if (typeof path !== "string") {
                return OpenDSUSafeCallback(callback)(createOpenDSUErrorWrapper("Provided path for writeFileFromBricks must be a string"));
            }

            Object.assign(defaultOpts, options);
            options = defaultOpts;

            if (options.ignoreMounts === true) {
                _getBigFileBricksMeta(path, callback);
            } else {
                this.getArchiveForPath(path, (err, dossierContext) => {
                    if (err) {
                        return OpenDSUSafeCallback(callback)(createOpenDSUErrorWrapper(`Failed to load DSU instance mounted at path ${path}`, err));
                    }
                    if (dossierContext.readonly === true) {
                        return callback(Error("Tried to write in a readonly mounted RawDossier"));
                    }

                    options.ignoreMounts = true;
                    dossierContext.archive.getBigFileBricksMeta(dossierContext.relativePath, options, callback);
                });
            }
        });
    }

    this.delete = (path, options, callback) => {
        waitIfDSUIsRefreshing(() => {
            const defaultOpts = {ignoreMounts: false, ignoreError: false};
            if (typeof options === 'function') {
                callback = options;
                options = {};
            }
            callback = $$.makeSaneCallback(callback);

            Object.assign(defaultOpts, options);
            options = defaultOpts;

            if (options.ignoreMounts) {
                return _delete(path, err => {
                    if (!err || (err && options.ignoreError)) {
                        return callback();
                    }

                    callback(err);
                });
            }

            this.getArchiveForPath(path, (err, dossierContext) => {
                if (err) {
                    return OpenDSUSafeCallback(callback)(createOpenDSUErrorWrapper(`Failed to load DSU instance mounted at path ${path}`, err));
                }

                if (dossierContext.readonly === true) {
                    return callback(Error("Tried to delete in a readonly mounted RawDossier"));
                }

                options.ignoreMounts = true;
                dossierContext.archive.delete(dossierContext.relativePath, options, callback);
            });
        })
    };

    this.rename = (srcPath, dstPath, options, callback) => {
        waitIfDSUIsRefreshing(() => {
            const defaultOpts = {ignoreMounts: false};
            if (typeof options === 'function') {
                callback = options;
                options = {};
            }

            callback = $$.makeSaneCallback(callback);
            Object.assign(defaultOpts, options);
            options = defaultOpts;

            if (options.ignoreMounts) {
                _rename(srcPath, dstPath, callback);
                return;
            }

            this.getArchiveForPath(srcPath, (err, dossierContext) => {
                if (err) {
                    return OpenDSUSafeCallback(callback)(createOpenDSUErrorWrapper(`Failed to load DSU instance mounted at path ${srcPath}`, err));
                }
                if (dossierContext.readonly === true) {
                    return callback(Error("Tried to rename in a readonly mounted RawDossier"));
                }

                const relativeSrcPath = dossierContext.relativePath;
                this.getArchiveForPath(dstPath, (err, dstDossierContext) => {
                    if (err) {
                        return OpenDSUSafeCallback(callback)(createOpenDSUErrorWrapper(`Failed to load DSU instance mounted at path ${dstPath}`, err));
                    }

                    if (dstDossierContext.prefixPath !== dossierContext.prefixPath) {
                        return callback(Error('Destination is invalid. Renaming must be done in the scope of the same dossier'));
                    }

                    options.ignoreMounts = true;
                    dossierContext.archive.rename(relativeSrcPath, dstDossierContext.relativePath, options, callback);
                })
            });
        })
    };

    this.listFiles = (path, options, callback) => {
        waitIfDSUIsRefreshing(() => {
            const defaultOpts = {ignoreMounts: false, recursive: true};
            if (typeof options === 'function') {
                callback = options;
                options = {};
            }

            callback = $$.makeSaneCallback(callback);
            Object.assign(defaultOpts, options);
            options = defaultOpts;
            if (options.ignoreMounts === true) {
                if (!options.recursive) {
                    return _listFiles(path, options, callback);
                }

                return _listFiles(path, options, (err, files) => {
                    if (err) {
                        return OpenDSUSafeCallback(callback)(createOpenDSUErrorWrapper(`Failed to list files at path ${path}`, err));
                    }

                    getManifest((err, manifest) => {
                        if (err) {
                            return OpenDSUSafeCallback(callback)(createOpenDSUErrorWrapper(`Failed to get manifest`, err));
                        }

                        const mountPoints = manifest.getMountPoints();
                        if (!mountPoints.length) {
                            return callback(undefined, files);
                        }

                        _listMountedFiles(mountPoints, (err, mountedFiles) => {
                            if (err) {
                                return OpenDSUSafeCallback(callback)(createOpenDSUErrorWrapper(`Failed to list mounted files at mountPoints ${mountPoints}`, err));
                            }

                            files = files.concat(...mountedFiles);
                            return callback(undefined, files);
                        });
                    })
                })
            }

            this.getArchiveForPath(path, (err, result) => {
                if (err) {
                    return OpenDSUSafeCallback(callback)(createOpenDSUErrorWrapper(`Failed to load DSU instance mounted at path ${path}`, err));
                }

                options.ignoreMounts = true;
                result.archive.listFiles(result.relativePath, options, callback);
            });
        })
    };

    this.listFolders = (path, options, callback) => {
        waitIfDSUIsRefreshing(() => {
            const defaultOpts = {ignoreMounts: false, recursive: false};
            if (typeof options === 'function') {
                callback = options;
                options = {};
            }

            callback = $$.makeSaneCallback(callback);
            Object.assign(defaultOpts, options);
            options = defaultOpts;

            if (options.ignoreMounts === true) {
                if (!options.recursive) {
                    return _listFolders(path, options, callback);
                }

                return _listFolders(path, options, (err, folders) => {
                    if (err) {
                        return OpenDSUSafeCallback(callback)(createOpenDSUErrorWrapper(`Failed to list folders at path ${path}`, err));
                    }

                    getManifest((err, manifest) => {
                        if (err) {
                            return OpenDSUSafeCallback(callback)(createOpenDSUErrorWrapper(`Failed to get manifest`, err));
                        }

                        const mountPoints = manifest.getMountPoints();
                        if (!mountPoints.length) {
                            return callback(undefined, folders);
                        }

                        _listMountedFolders(mountPoints, (err, mountedFolders) => {
                            if (err) {
                                return OpenDSUSafeCallback(callback)(createOpenDSUErrorWrapper(`Failed to list mounted folders at mountPoints ${mountPoints}`, err));
                            }

                            folders = folders.concat(...mountedFolders);
                            return callback(undefined, folders);
                        });
                    })
                })
            }

            this.getArchiveForPath(path, (err, result) => {
                if (err) {
                    return OpenDSUSafeCallback(callback)(createOpenDSUErrorWrapper(`Failed to load DSU instance mounted at path ${path}`, err));
                }

                options.ignoreMounts = true;
                result.archive.listFolders(result.relativePath, options, callback);
            });
        })
    };

    this.createFolder = (barPath, options, callback) => {
        waitIfDSUIsRefreshing(() => {
            const defaultOpts = {ignoreMounts: false, encrypt: true};
            if (typeof options === "function") {
                callback = options;
                options = {};
            }

            callback = $$.makeSaneCallback(callback);
            Object.assign(defaultOpts, options);
            options = defaultOpts;

            if (options.ignoreMounts === true) {
                _createFolder(barPath, callback);
            } else {
                this.getArchiveForPath(barPath, (err, dossierContext) => {
                    if (err) {
                        return OpenDSUSafeCallback(callback)(createOpenDSUErrorWrapper(`Failed to load DSU instance mounted at path ${barPath}`, err));
                    }
                    if (dossierContext.readonly === true) {
                        return callback(Error("Tried to write in a readonly mounted RawDossier"));
                    }

                    options.ignoreMounts = true;
                    dossierContext.archive.createFolder(dossierContext.relativePath, options, callback);
                });
            }
        })
    };

    this.readDir = (folderPath, options, callback) => {
        waitIfDSUIsRefreshing(() => {
            if (typeof options === "function") {
                callback = options;
                options = {
                    withFileTypes: false
                };
            }

            callback = $$.makeSaneCallback(callback);
            const entries = {};
            this.getArchiveForPath(folderPath, (err, result) => {
                if (err) {
                    return OpenDSUSafeCallback(callback)(createOpenDSUErrorWrapper(`Failed to load DSU instance mounted at path ${folderPath}`, err));
                }

                result.archive.listFiles(result.relativePath, {recursive: false, ignoreMounts: true}, (err, files) => {
                    if (err) {
                        return OpenDSUSafeCallback(callback)(createOpenDSUErrorWrapper(`Failed to list files at path ${result.relativePath}`, err));
                    }

                    entries.files = files;

                    result.archive.listFolders(result.relativePath, {
                        recursive: false,
                        ignoreMounts: true
                    }, (err, folders) => {
                        if (err) {
                            return OpenDSUSafeCallback(callback)(createOpenDSUErrorWrapper(`Failed to list folders at path ${result.relativePath}`, err));
                        }

                        if (options.withFileTypes) {
                            entries.folders = folders;
                        } else {
                            entries.files = [...entries.files, ...folders];
                        }
                        if (result.archive === this) {
                            getManifest(listMounts);
                        } else {
                            Manifest.getManifest(result.archive, listMounts);
                        }

                        function listMounts(err, handler) {
                            if (err) {
                                return OpenDSUSafeCallback(callback)(createOpenDSUErrorWrapper(`Failed to list mounts`, err));
                            }

                            handler.getMountedDossiers(result.relativePath, (err, mounts) => {
                                if (err) {
                                    return OpenDSUSafeCallback(callback)(createOpenDSUErrorWrapper(`Failed to get mounted DSUs at path ${result.relativePath}`, err));
                                }
                                let mountPaths = mounts.map(mount => mount.path);
                                let folders = mountPaths.filter(mountPath => mountPath.split('/').length >= 2);
                                folders = folders.map(mountPath => mountPath.split('/').shift());
                                let mountedDossiers = mountPaths.filter(mountPath => mountPath.split('/').length === 1);
                                mountedDossiers = mountedDossiers.map(mountPath => mountPath.split('/').shift());
                                if (options.withFileTypes) {
                                    entries.mounts = mountedDossiers;
                                    entries.folders = Array.from(new Set([...entries.folders, ...folders]));
                                    entries.mounts = entries.mounts.filter(mount => entries.folders.indexOf(mount) === -1);
                                    return callback(undefined, entries);
                                }
                                entries.files = Array.from(new Set([...entries.files, ...mounts, ...folders]));
                                return callback(undefined, entries.files);
                            });
                        }
                    });
                });
            });
        })
    };

    this.cloneFolder = (srcPath, destPath, options, callback) => {
        waitIfDSUIsRefreshing(() => {
            const defaultOpts = {ignoreMounts: false};
            if (typeof options === 'function') {
                callback = options;
                options = {};
            }

            callback = $$.makeSaneCallback(callback);
            Object.assign(defaultOpts, options);
            options = defaultOpts;

            if (options.ignoreMounts) {
                brickMapController.cloneFolder(srcPath, destPath, callback);
                return;
            }

            this.getArchiveForPath(srcPath, (err, dossierContext) => {
                if (err) {
                    return OpenDSUSafeCallback(callback)(createOpenDSUErrorWrapper(`Failed to load DSU instance mounted at path ${srcPath}`, err));
                }
                if (dossierContext.readonly === true) {
                    return callback(Error("Tried to rename in a readonly mounted RawDossier"));
                }

                this.getArchiveForPath(destPath, (err, dstDossierContext) => {
                    if (err) {
                        return OpenDSUSafeCallback(callback)(createOpenDSUErrorWrapper(`Failed to load DSU instance mounted at path ${destPath}`, err));
                    }

                    if (dstDossierContext.prefixPath !== dossierContext.prefixPath) {
                        return callback(Error('Destination is invalid. Renaming must be done in the scope of the same dossier'));
                    }

                    options.ignoreMounts = true;
                    dossierContext.archive.cloneFolder(dossierContext.relativePath, dstDossierContext.relativePath, options, callback);
                })
            });
        })
    }

    this.mount = (path, archiveSSI, options, callback) => {
        waitIfDSUIsRefreshing(() => {
            if (typeof options === "function") {
                callback = options;
                options = undefined;
            }

            callback = $$.makeSaneCallback(callback);

            const keySSISpace = require("opendsu").loadAPI("keyssi");

            if (typeof archiveSSI === "string") {
                try {
                    archiveSSI = keySSISpace.parse(archiveSSI);
                } catch (e) {
                    return callback(createOpenDSUErrorWrapper(`The provided archiveSSI is not a valid SSI string.`, e));
                }
            }

            if (typeof archiveSSI === "object") {
                try {
                    archiveSSI = archiveSSI.getIdentifier();
                } catch (e) {
                    return callback(createOpenDSUErrorWrapper(`The provided archiveSSI is not a valid SSI instance`));
                }
            } else {
                return callback(createOpenDSUErrorWrapper(`The provided archiveSSI is neither a string nor a valid SSI instance`));
            }

            function internalMount() {
                _listFiles(path, (err, files) => {
                    if (!err && files.length > 0) {
                        return callback(Error("Tried to mount in a non-empty folder"));
                    }
                    getManifest((err, manifestHandler) => {
                        if (err) {
                            return OpenDSUSafeCallback(callback)(createOpenDSUErrorWrapper(`Failed to get manifest handler`, err));
                        }

                        manifestHandler.mount(path, archiveSSI, options, callback);
                    });
                });
            }

            this.getArchiveForPath(path, (err, result) => {
                if (err) {
                    return OpenDSUSafeCallback(callback)(createOpenDSUErrorWrapper(`Failed to load DSU instance mounted at path ${path}`, err));
                }
                if (result.relativePath === path) {
                    internalMount()
                } else {
                    result.archive.mount(result.relativePath, archiveSSI, options, callback)
                }
            });
        })
    };

    this.unmount = (path, callback) => {
        waitIfDSUIsRefreshing(() => {
            callback = $$.makeSaneCallback(callback);

            getManifest((err, manifestHandler) => {
                if (err) {
                    return OpenDSUSafeCallback(callback)(createOpenDSUErrorWrapper(`Failed to get manifest handler`, err));
                }

                manifestHandler.unmount(path, callback);
            });
        })
    };

    this.listMountedDossiers = (path, callback) => {
        waitIfDSUIsRefreshing(() => {
            callback = $$.makeSaneCallback(callback);

            this.getArchiveForPath(path, (err, result) => {
                if (err) {
                    return OpenDSUSafeCallback(callback)(createOpenDSUErrorWrapper(`Failed to load DSU instance mounted at path ${path}`, err));
                }

                if (result.archive === this) {
                    getManifest(listMounts);
                } else {
                    Manifest.getManifest(result.archive, listMounts);
                }

                function listMounts(err, handler) {
                    if (err) {
                        return OpenDSUSafeCallback(callback)(createOpenDSUErrorWrapper(`Failed to list mounts`, err));
                    }

                    handler.getMountedDossiers(result.relativePath, callback);
                }
            });
        })
    };

    this.listMountedDSUs = this.listMountedDossiers;

    this.hasUnanchoredChanges = (callback) => {
        const detectChangesInMountedDSU = (callback, changesExist = false, dsuIndex = 0) => {
            if (dsuIndex >= mountedArchivesForBatchOperations.length) {
                return callback(undefined, changesExist);
            }

            const context = mountedArchivesForBatchOperations[dsuIndex++];
            context.archive.hasUnanchoredChanges((err, result) => {
                if (err) {
                    return callback(err);
                }

                detectChangesInMountedDSU(callback, result || changesExist, dsuIndex);
            })
        }

        waitIfDSUIsRefreshing(() => {
            detectChangesInMountedDSU((err, changesExist) => {
                if (err) {
                    return callback(err);
                }

                callback(undefined, brickMapController.hasUnanchoredChanges() || changesExist);
            })
        });
    };

    this.getArchiveForPath = (path, callback) => {
        waitIfDSUIsRefreshing(() => {
            callback = $$.makeSaneCallback(callback);

            getManifest((err, handler) => {
                if (err) {
                    return OpenDSUSafeCallback(callback)(createOpenDSUErrorWrapper(`Failed to get manifest handler`, err));
                }

                if (this.batchInProgress()) {
                    return getArchiveForBatchOperations(handler, path, callback);
                }


                handler.getArchiveForPath(path, (err, result) => {
                    if (err) {
                        return OpenDSUSafeCallback(callback)(createOpenDSUErrorWrapper(`Failed to load DSU instance mounted at path ${path}`, err));
                    }


                    if (result.archive === this) {
                        return callback(undefined, result);
                    }

                    callback(undefined, result);
                });
            });
        })
    };

    /**
     * Start a batch of operations
     * This will force the anchoring when the
     * batch is commited
     */
    this.beginBatch = () => {
        if (batchOperationsInProgress) {
            throw new Error("Another anchoring transaction is already in progress. Cancel the previous batch and try again.");
        }

        batchOperationsInProgress = true;

        // Save the previous decision function
        const anchoringStrategy = this.getAnchoringStrategy();
        prevAnchoringDecisionFn = anchoringStrategy.getDecisionFunction();

        // Prevent anchoring after each operation
        anchoringStrategy.setDecisionFunction((brickMap, callback) => {
            return callback(undefined, false);
        })
    };

    /**
     * @return {boolean}
     */
    this.batchInProgress = () => {
        return batchOperationsInProgress;
    }

    /**
     * Anchor batch of changes
     * @param {callback} onConflict If defined it will be called if a conflict occurs
     * @param {callback} callback
     */
    this.commitBatch = (onConflict, callback) => {
        if (typeof callback === 'undefined') {
            callback = onConflict;
            onConflict = undefined;
        }
        if (!batchOperationsInProgress) {
            const err = new Error("Unable to commit batch because no batch operations have been started");
            const constants = require("opendsu").constants;
            return callback(createOpenDSUErrorWrapper(`Failed to commit batch`, err, constants.ERROR_ROOT_CAUSE.DSU_INVALID_OPERATION));
        }

        let usesOnConflictCallback = false;

        const anchoringStrategy = this.getAnchoringStrategy();
        if (!anchoringStrategy.getConflictResolutionFunction() && typeof onConflict !== 'undefined') {
            prevConflictResolutionFunction = anchoringStrategy.getConflictResolutionFunction();
            // Set 'onConflict' callback
            anchoringStrategy.setConflictResolutionFunction(onConflict);
            usesOnConflictCallback = true;
        }

        commitBatchesInMountedArchives(onConflict, (err) => {
            if (err) {
                batchOperationsInProgress = false;
                return OpenDSUSafeCallback(callback)(createOpenDSUErrorWrapper(`Failed to anchor`, err));
            }

            this.doAnchoring((err, result) => {
                anchoringStrategy.setDecisionFunction(prevAnchoringDecisionFn);
                if (usesOnConflictCallback) {
                    // Restore the 'conflictResolutionFn'
                    anchoringStrategy.setConflictResolutionFunction(prevConflictResolutionFunction);
                }

                if (err) {
                    batchOperationsInProgress = false;
                    return OpenDSUSafeCallback(callback)(createOpenDSUErrorWrapper(`Failed to anchor`, err));
                }

                batchOperationsInProgress = false;
                callback(undefined, result);
            });
        });
    };

    /**
     * Cancel the current anchoring batch
     */
    this.cancelBatch = (callback) => {
        if (!batchOperationsInProgress) {
            const err = new Error("Unable to cancel batch because no batch operations have been started");
            const constants = require("opendsu").constants;
            return callback(createOpenDSUErrorWrapper(`Failed to cancel batch`, err, constants.ERROR_ROOT_CAUSE.DSU_INVALID_OPERATION));
        }

        cancelBatchesInMountedArchives((err) => {
            if (err) {
                return OpenDSUSafeCallback(callback)(createOpenDSUErrorWrapper(`Failed to cancel batches in mounted archive`, err));
            }

            batchOperationsInProgress = false;
            this.getAnchoringStrategy().setDecisionFunction(prevAnchoringDecisionFn);
            this.load((err) => {
                if (err) {
                    return OpenDSUSafeCallback(callback)(createOpenDSUErrorWrapper(`Failed to load current DSU`, err));
                }
                callback();
            })
        });
    };

    /**
     * Execute a batch of operations
     * then anchor the changes
     *
     * @param {function} batch
     * @param {callback} callback
     */
    this.batch = (batch, callback) => {
        this.beginBatch();
        batch((err) => {
            if (err) {
                return OpenDSUSafeCallback(callback)(createOpenDSUErrorWrapper(`Failed to execute batch operations`, err));
            }

            this.commitBatch(callback);
        });
    }

    /**
     * @param {function} handler
     */
    this.setMergeConflictsHandler = (handler) => {
        this.getAnchoringStrategy().setConflictResolutionFunction(handler);
    }

    this.stat = (path, callback) => {
        waitIfDSUIsRefreshing(() => {
            callback = $$.makeSaneCallback(callback);

            this.getArchiveForPath(path, (err, res) => {
                if (err) {
                    return callback(undefined, {type: undefined});
                }

                if (res.archive === this) {
                    let stats;
                    try {
                        stats = brickMapController.stat(path);
                    } catch (e) {
                        return callback(undefined, {type: undefined});
                    }

                    callback(undefined, stats);
                } else {
                    res.archive.stat(res.relativePath, callback);
                }
            });
        })
    };
}

module.exports = Archive;
