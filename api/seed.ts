import { requireAuth } from "./_lib/auth.js"
import { route } from "./_lib/http.js"
import { seedOps } from "./_lib/seed.js"

export default route(["GET"], (req, res) => {
  if (!requireAuth(req, res)) return
  res.status(200).json({ ops: seedOps() })
})
