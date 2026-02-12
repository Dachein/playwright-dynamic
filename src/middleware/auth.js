const { API_TOKEN } = require('../config')

/**
 * 🔐 认证中间件
 */
function authMiddleware(req, res, next) {
  const token = req.query.token || req.headers['x-api-token']

  if (token !== API_TOKEN) {
    return res.status(401).json({ success: false, error: 'Unauthorized' })
  }
  next()
}

module.exports = { authMiddleware }
