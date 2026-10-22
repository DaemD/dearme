import { route } from "./_lib/http.js"

export default route(["GET"], (_req, res) => {
  res.status(200).json({ status: "running" })
})
