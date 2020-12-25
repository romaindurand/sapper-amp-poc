export default function ampMiddleware (req, res, next) {
  if (!req.path.startsWith('/amp/')) return next()
}
