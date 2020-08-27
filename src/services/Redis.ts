import { Injector } from 'reduct'
import * as ioredis from 'ioredis'
import * as ioredisMock from 'ioredis-mock'
import * as Long from 'long'
import * as crypto from 'crypto'
import { v4 as uuidv4 } from 'uuid'
import { Config } from './Config'
import { Receipt } from 'ilp-protocol-stream'
import { URL } from 'url'

interface CustomRedis extends ioredis.Redis {
  getReceiptValue(
    key: string,
    tempKey: string,
    streamId: string,
    amount: string
  ): Promise<string>
  creditBalance(key: string, amount: string): Promise<string>
  spendBalance(key: string, amount: string): Promise<string>
}

interface CustomRedisMock extends ioredisMock {
  getReceiptValue(
    key: string,
    tempKey: string,
    streamId: string,
    amount: string
  ): Promise<string>
  creditBalance(key: string, amount: string): Promise<string>
  spendBalance(key: string, amount: string): Promise<string>
}

export const BALANCE_KEY = 'ilpBalances'
export const RECEIPT_KEY = 'ilpReceipts'
const TEMP_KEY = 'ilpTemp'

export class Redis {
  private config: Config
  private redis: CustomRedis | CustomRedisMock

  constructor(deps: Injector) {
    this.config = deps(Config)
  }

  start(): void {
    if (this.config.redisUri === 'mock') {
      this.redis = new ioredisMock() as CustomRedisMock
    } else {
      this.redis = new ioredis(this.config.redisUri) as CustomRedis
    }

    // These Redis scripts use Redis to handle all numbers to avoid the
    // limited precision of Javascript and Lua numbers
    this.redis.defineCommand('getReceiptValue', {
      numberOfKeys: 2,
      lua: `
local streamId = ARGV[1]
local amount = ARGV[2]
local prevAmount = redis.call('hget', KEYS[1], streamId)
if prevAmount then
  local tempKey = KEYS[2]
  redis.call('set', tempKey, amount, 'EX', 1)
  redis.call('decrby', tempKey, prevAmount)
  local diff = redis.call('get', tempKey)
  if string.sub(diff, 1, 1) == '-' then
    return '0'
  else
    redis.call('hset', KEYS[1], streamId, amount)
    return diff
  end
else
  redis.call('hset', KEYS[1], streamId, amount)
  return amount
end
`,
    })

    this.redis.defineCommand('creditBalance', {
      numberOfKeys: 1,
      lua: `
local amount = ARGV[1]
redis.call('incrby', KEYS[1], amount)
return redis.call('get', KEYS[1])
`,
    })

    this.redis.defineCommand('spendBalance', {
      numberOfKeys: 1,
      lua: `
if redis.call('get', KEYS[1]) then
  local amount = ARGV[1]
  redis.call('decrby', KEYS[1], amount)
  local balance = redis.call('get', KEYS[1])
  if string.sub(balance, 1, 1) == '-' then
    redis.call('incrby', KEYS[1], amount)
    return redis.error_reply('insufficient balance')
  else
    return balance
  end
else
  return redis.error_reply('balance does not exist')
end
`,
    })
  }

  async stop(): Promise<void> {
    await this.redis.quit()
  }

  get _redis() {
    return this.redis
  }

  async flushdb(): Promise<void> {
    await this.redis.flushdb()
  }

  async setReceiptTTL(nonce: string): Promise<void> {
    const key = `${RECEIPT_KEY}:${nonce}`
    await this.redis.hset(key, 'dummy', 0)
    await this.redis.expire(key, this.config.receiptTTLSeconds)
  }

  async getReceiptValue(receipt: Receipt): Promise<Long> {
    if (receipt.totalReceived.compare(Long.MAX_VALUE) === 1) {
      throw new Error('receipt amount exceeds max 64 bit signed integer')
    }
    const key = `${RECEIPT_KEY}:${receipt.nonce.toString('base64')}`
    if (await this.redis.exists(key)) {
      const tempKey = `${TEMP_KEY}:${uuidv4()}`
      const value = await this.redis.getReceiptValue(
        key,
        tempKey,
        receipt.streamId,
        receipt.totalReceived.toString()
      )
      return Long.fromString(value)
    } else {
      return Long.UZERO
    }
  }

  async creditBalance(id: string, amount: Long): Promise<Long> {
    if (amount.isNegative()) {
      throw new Error('credit amount must not be negative')
    } else if (amount.compare(Long.MAX_VALUE) === 1) {
      throw new Error('credit amount exceeds max 64 bit signed integer')
    }
    const key = `${BALANCE_KEY}:${id}`
    try {
      const balance = await this.redis.creditBalance(key, amount.toString())
      return Long.fromString(balance)
    } catch (err) {
      throw new Error('balance cannot exceed max 64 bit signed integer')
    }
  }

  async spendBalance(id: string, amount: Long): Promise<Long> {
    if (amount.isNegative()) {
      throw new Error('spend amount must not be negative')
    } else if (amount.compare(Long.MAX_VALUE) === 1) {
      throw new Error('spend amount exceeds max 64 bit signed integer')
    }
    const key = `${BALANCE_KEY}:${id}`
    const balance = await this.redis.spendBalance(key, amount.toString())
    return Long.fromString(balance)
  }

  async createProxy(pointer: string): Promise<string> {
    const endpoint = new URL(
      pointer.startsWith('$') ? 'https://' + pointer.substring(1) : pointer
    )
    const hashedPointer = crypto
      .createHash('sha256')
      .update(pointer)
      .digest('hex')
    await this.redis.set(hashedPointer, endpoint.href)
    return hashedPointer
  }

  async getPointer(hashedPointer: string): Promise<string> {
    const pointer = await this.redis.get(hashedPointer)
    if (pointer) return pointer
    else {
      throw new Error('pointer not found')
    }
  }

  async deleteProxy(hashedPointer: string) {
    await this.redis.del(hashedPointer)
  }
}
