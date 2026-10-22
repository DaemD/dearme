import { safeEqual, signToken, signingSecret, USERNAME } from "./_lib/auth.js"
import { bodyOf, clientKey, fail, route } from "./_lib/http.js"
import { recordFailure, recordSuccess, retryAfter } from "./_lib/ratelimit.js"

export default route(["POST"], async (req, res) => {
  if (!signingSecret()) return fail(res, 500, "The server is not set up correctly.")
  const expected = process.env.ACCESS_PASSWORD
  if (!expected) return fail(res, 503, "Login is not set up yet.") // fail closed

  const client = clientKey(req)
  const wait = await retryAfter("login", client)
  if (wait > 0) {
    res.setHeader("Retry-After", String(wait))
    return fail(res, 429, `Too many attempts. Try again in ${Math.ceil(wait / 60)} minutes.`)
  }

  const body = bodyOf(req) as { password?: unknown } | undefined
  const supplied = typeof body?.password === "string" ? body.password : ""
  if (!safeEqual(supplied, expected)) {
    await recordFailure("login", client)
    return fail(res, 401, "Incorrect password")
  }
  await recordSuccess("login", client)
  res.status(200).json({ token: signToken(), user: { username: USERNAME } })
})
