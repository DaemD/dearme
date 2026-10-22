// The login token lives in the browser. Everything that calls /api uses these helpers.
const TOKEN_KEY = "zeneb_lite_token"

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}

export function saveToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token)
  } catch {
    /* storage blocked: the session just will not survive a reload */
  }
}

export function clearToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY)
  } catch {
    /* nothing to clear */
  }
}

let unauthorizedHandler: (() => void) | null = null

/** The app registers what should happen when the server says the login is no longer valid. */
export function setUnauthorizedHandler(handler: () => void): void {
  unauthorizedHandler = handler
}

/** API code calls this on any 401 (except from /api/login itself). */
export function handleUnauthorized(): void {
  clearToken()
  unauthorizedHandler?.()
}
