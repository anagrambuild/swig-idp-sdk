import { DEFAULT_ISOLATED_HOST_URL, DEFAULT_NETWORK } from "./config.js";
import { type NetworkValue } from "./utils.js";

const MESSAGE_TYPE = "swig:email-otp:v1";
const REQUEST_TIMEOUT_MS = 180_000;

export interface EmailOtpConfig {
  isolatedHostUrl?: string;
  redirectUri?: string;
  network?: NetworkValue;
}

export interface StartEmailCodeInput {
  email: string;
  clientId: string;
  oidcNonce: string;
  state?: string;
  provider?: string;
  redirectUri?: string;
  network?: NetworkValue;
  walletSalt?: string;
}

export interface EmailCodeChallenge {
  challengeId: string;
  maskedRecipient: string;
  expiresAt: string;
  resendAfterSeconds: number;
}

export interface EmailCodeCompletion {
  status: "complete";
  /** Contains the app ID token. Keep in memory; verify the app session before persisting SDK metadata. */
  callbackUrl: string;
}

export type EmailCodeVerification = EmailCodeCompletion | { status: "approval_required" };
export interface EmailCodeRequestOptions { signal?: AbortSignal }

export class EmailOtpError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "EmailOtpError";
  }
}

type Command =
  | { method: "start"; input: StartEmailCodeInput & { redirectUri: string; network: NetworkValue } }
  | { method: "verify"; challengeId: string; code: string }
  | { method: "resend"; challengeId: string }
  | { method: "complete"; challengeId: string };

/** Browser-only email authentication with application-owned forms and isolated key handling. */
export class EmailOtpClient {
  private iframe: HTMLIFrameElement | null = null;
  private channel: string | null = null;
  private challenge: EmailCodeChallenge | null = null;
  private approvalId: string | null = null;
  private callback: { redirectUri: string; state: string } | null = null;
  private stopRequest: ((reason: unknown) => void) | null = null;
  private popup: Window | null = null;
  private busy = false;
  private readonly host: URL;

  constructor(private readonly config: EmailOtpConfig = {}) {
    this.host = new URL(config.isolatedHostUrl ?? DEFAULT_ISOLATED_HOST_URL);
    if (this.host.username || this.host.password || (this.host.protocol !== "https:" && !(this.host.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(this.host.hostname)))) {
      throw new EmailOtpError("invalid_config", "The isolated host must use HTTPS");
    }
  }

  async start(input: StartEmailCodeInput, options: EmailCodeRequestOptions = {}): Promise<EmailCodeChallenge> {
    if (this.busy) throw new EmailOtpError("busy", "An email request is already in progress");
    this.cancel();
    const redirectUri = input.redirectUri ?? this.config.redirectUri;
    if (!redirectUri || new URL(redirectUri).origin !== window.location.origin) {
      throw new EmailOtpError("invalid_request", "The callback must belong to this application origin");
    }
    this.busy = true;
    try {
      this.callback = { redirectUri, state: input.state ?? "" };
      await this.connect(options.signal);
      const result = await this.request({ method: "start", input: { ...input, redirectUri, network: input.network ?? this.config.network ?? DEFAULT_NETWORK } }, options.signal);
      if (!isRecord(result) || typeof result.challengeId !== "string" || !result.challengeId || typeof result.maskedRecipient !== "string" || typeof result.expiresAt !== "string" || !Number.isFinite(Date.parse(result.expiresAt)) || !validCooldown(result.resendAfterSeconds)) {
        throw new EmailOtpError("invalid_response", "Invalid email challenge response");
      }
      this.challenge = { challengeId: result.challengeId, maskedRecipient: result.maskedRecipient, expiresAt: result.expiresAt, resendAfterSeconds: result.resendAfterSeconds };
      return { ...this.challenge };
    } catch (error) {
      this.cancel();
      throw error;
    } finally { this.busy = false; }
  }

  async verify(input: { challengeId: string; code: string }, options: EmailCodeRequestOptions = {}): Promise<EmailCodeVerification> {
    this.requireChallenge(input.challengeId);
    if (!/^\d{6}$/.test(input.code)) throw new EmailOtpError("invalid_code", "Enter the six-digit code");
    this.busy = true;
    try {
      const result = await this.request({ method: "verify", ...input }, options.signal);
      if (isRecord(result) && result.status === "approval_required" && typeof result.approvalId === "string" && result.approvalId) {
        this.approvalId = result.approvalId;
        return { status: "approval_required" };
      }
      return this.completion(result);
    } finally { this.busy = false; }
  }

  async resend(input: { challengeId: string }, options: EmailCodeRequestOptions = {}): Promise<{ resendAfterSeconds: number }> {
    this.requireChallenge(input.challengeId);
    this.busy = true;
    try {
      const result = await this.request({ method: "resend", ...input }, options.signal);
      if (!isRecord(result) || !validCooldown(result.resendAfterSeconds)) throw new EmailOtpError("invalid_response", "Invalid resend response");
      return { resendAfterSeconds: result.resendAfterSeconds };
    } finally { this.busy = false; }
  }

  /** Call directly from a user click. Only new developer access opens trusted consent UI. */
  async approve(input: { challengeId: string }, options: EmailCodeRequestOptions = {}): Promise<EmailCodeCompletion> {
    this.requireChallenge(input.challengeId);
    if (!this.approvalId || !this.iframe) throw new EmailOtpError("invalid_request", "No wallet approval is pending");
    const frameIndex = Array.from(document.querySelectorAll("iframe, frame")).indexOf(this.iframe);
    if (frameIndex < 0) throw new EmailOtpError("cancelled", "The authentication frame was removed");
    const url = new URL("/email-otp/approval", this.host);
    url.hash = new URLSearchParams({ channel: this.channel ?? "", approvalId: this.approvalId, frameIndex: String(frameIndex) }).toString();
    const popup = window.open(url.toString(), "_blank", "popup,width=480,height=720");
    if (!popup) throw new EmailOtpError("popup_blocked", "Allow the wallet approval popup, then try again");
    this.popup = popup;
    this.busy = true;
    const closePoll = setInterval(() => {
      if (popup.closed) this.cancel(new EmailOtpError("popup_closed", "The wallet approval window was closed"));
    }, 500);
    try {
      return this.completion(await this.request({ method: "complete", ...input }, options.signal));
    } finally {
      clearInterval(closePoll);
      popup.close();
      this.popup = null;
      this.busy = false;
    }
  }

  /** Releases the frame, pending request, popup, and in-memory attempt. Safe to call repeatedly. */
  cancel(reason: unknown = new EmailOtpError("cancelled", "Email authentication was cancelled")): void {
    this.stopRequest?.(reason);
    this.stopRequest = null;
    this.iframe?.remove();
    this.iframe = null;
    this.channel = null;
    this.challenge = null;
    this.approvalId = null;
    this.callback = null;
    this.popup?.close();
    this.popup = null;
  }

  private requireChallenge(challengeId: string): void {
    if (this.busy) throw new EmailOtpError("busy", "An email request is already in progress");
    if (!this.challenge || this.challenge.challengeId !== challengeId) throw new EmailOtpError("invalid_challenge", "Restart email sign-in");
  }

  private completion(result: unknown): EmailCodeCompletion {
    if (!isRecord(result) || result.status !== "complete" || typeof result.callbackUrl !== "string" || !this.callback) {
      this.cancel();
      throw new EmailOtpError("invalid_response", "Invalid authentication completion");
    }
    let url: URL;
    try { url = new URL(result.callbackUrl); } catch {
      this.cancel();
      throw new EmailOtpError("invalid_response", "Invalid authentication callback URL");
    }
    const expected = new URL(this.callback.redirectUri);
    const fragment = new URLSearchParams(url.hash.slice(1));
    if (url.origin !== expected.origin || url.pathname !== expected.pathname || (url.searchParams.get("state") ?? "") !== this.callback.state || !fragment.get("id_token")) {
      this.cancel();
      throw new EmailOtpError("invalid_response", "Authentication completion does not match this application");
    }
    const completion: EmailCodeCompletion = { status: "complete", callbackUrl: result.callbackUrl };
    this.cancel();
    return completion;
  }

  private connect(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const iframe = document.createElement("iframe");
    this.iframe = iframe;
    this.channel = crypto.randomUUID();
    const url = new URL("/email-otp-bridge.html", this.host);
    url.hash = new URLSearchParams({ channel: this.channel, parentOrigin: window.location.origin }).toString();
    iframe.title = "Swig email authentication";
    iframe.hidden = true;
    iframe.src = url.toString();
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        window.removeEventListener("message", receive);
        signal?.removeEventListener("abort", abort);
        this.stopRequest = null;
      };
      const fail = (reason: unknown) => { cleanup(); reject(reason); };
      const abort = () => { this.cancel(signal?.reason); };
      const receive = (event: MessageEvent<unknown>) => {
        if (event.source !== iframe.contentWindow || event.origin !== this.host.origin || !isRecord(event.data) || event.data.type !== MESSAGE_TYPE || event.data.channel !== this.channel || event.data.kind !== "ready") return;
        cleanup(); resolve();
      };
      const timer = setTimeout(() => this.cancel(new EmailOtpError("timeout", "The authentication service did not load")), 20_000);
      this.stopRequest = fail;
      window.addEventListener("message", receive);
      signal?.addEventListener("abort", abort, { once: true });
      try { document.body.append(iframe); } catch (error) { this.cancel(error); }
    });
  }

  private request(command: Command, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) { this.cancel(signal.reason); return Promise.reject(signal.reason); }
    const frameWindow = this.iframe?.contentWindow;
    if (!frameWindow) return Promise.reject(new EmailOtpError("cancelled", "Restart email sign-in"));
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        window.removeEventListener("message", receive);
        signal?.removeEventListener("abort", abort);
        this.stopRequest = null;
      };
      const fail = (reason: unknown) => { cleanup(); reject(reason); };
      const abort = () => this.cancel(signal?.reason);
      const receive = (event: MessageEvent<unknown>) => {
        if (event.source !== frameWindow || event.origin !== this.host.origin || !isRecord(event.data) || event.data.type !== MESSAGE_TYPE || event.data.channel !== this.channel || event.data.requestId !== requestId || event.data.kind !== "response") return;
        const data = event.data;
        cleanup();
        if (data.ok === true) resolve(data.result);
        else if (data.ok === false && typeof data.code === "string" && typeof data.message === "string") reject(new EmailOtpError(data.code, data.message));
        else reject(new EmailOtpError("invalid_response", "Invalid authentication service response"));
      };
      const timer = setTimeout(() => this.cancel(new EmailOtpError("timeout", "Email authentication timed out; restart sign-in")), REQUEST_TIMEOUT_MS);
      this.stopRequest = fail;
      window.addEventListener("message", receive);
      signal?.addEventListener("abort", abort, { once: true });
      try {
        frameWindow.postMessage({ type: MESSAGE_TYPE, kind: "request", channel: this.channel, requestId, command }, this.host.origin);
      } catch (error) { this.cancel(error); }
    });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function validCooldown(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
