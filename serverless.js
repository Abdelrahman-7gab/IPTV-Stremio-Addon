const app = require('./server');

module.exports = function serverless(req, res) {
    return app(req, res);
};
