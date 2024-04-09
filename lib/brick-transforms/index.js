const EncryptionTransformation = require("./EncryptionTransformation");

const createBrickTransformation = (options) => {
    options = options || {};
    return new EncryptionTransformation(options);
};


module.exports = {
    createBrickTransformation
};

