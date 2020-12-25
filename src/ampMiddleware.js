import { manifest } from '@sapper/internal/manifest-server'
import { get_page_handler } from './get_page_handler'

export default function ampMiddleware (req, res, next) {
  if (!req.path.startsWith('/amp/')) return next()

  const pageHandler = get_page_handler(manifest, () => {})
  req.baseUrl = ''
  pageHandler(req, res)
}
