import { Injector } from 'reduct'
import { randomBytes } from 'crypto'

export class Config {
  readonly port: number
  readonly proxyPort: number
  readonly spspProxyPort: number
  readonly spspEndpoint: string
  readonly receiptSeed: Buffer
  readonly receiptTTLSeconds: number
  readonly redisUri: string

  constructor(env: Injector | { [k: string]: string | undefined }) {
    // Load config from environment by default
    if (typeof env === 'function') {
      env = process.env
    }
    this.port = Number(env.VERIFIER_PORT) || 3000
    this.spspProxyPort = Number(env.SPSP_PROXY_PORT) || 3001
    this.proxyPort = Number(env.PROXY_PORT) || 3002
    this.receiptSeed = env.RECEIPT_SEED
      ? Buffer.from(env.RECEIPT_SEED, 'base64')
      : randomBytes(32)
    this.receiptTTLSeconds = Number(env.RECEIPT_TTL) || 300
    // if (env.SPSP_ENDPOINT) {
    //   this.spspEndpoint = env.SPSP_ENDPOINT
    // } else {
    //   throw new Error("receipt-verifier requires SPSP_ENDPOINT to be set")
    // }
    this.redisUri = env.REDIS_URI || 'redis://127.0.0.1:6379/'
  }
}
