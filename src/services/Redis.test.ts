import reduct from 'reduct'
import { Redis, BALANCE_KEY, RECEIPT_KEY } from './Redis'
import { Config } from './Config'
import { Receipt } from '../lib/Receipt'
import * as Long from 'long'

describe('Redis', () => {
  let config: Config
  let redis: Redis

  process.env.SPSP_ENDPOINT = 'http://localhost:3000'

  beforeAll(async () => {
    const deps = reduct()
    config = deps(Config)
  })

  describe('constructor', () => {
    it('construct new Redis service', () => {
      const redis = reduct()(Redis)
    })
  })

  beforeAll(async () => {
    redis = reduct()(Redis)
    redis.start()
  })

  beforeEach(async () => {
    await redis.flushdb()
  })

  afterAll(async () => {
    await redis.flushdb()
    await redis.stop()
  })

  describe('getReceiptValue', () => {

    const streamTime = new Date('2000-01-01T00:00:00.000Z')
    const now        = new Date('2000-01-01T00:01:00.000Z')
    const streamStartTime = Long.fromNumber(Math.floor(streamTime.valueOf() / 1000), true)

    beforeAll(() => {
      jest.spyOn(global.Date, 'now')
      .mockImplementation(() =>
        now.valueOf()
      )
    })

    afterAll(() => {
      jest.clearAllMocks()
    })

    it('returns the amount of the initial receipt', async () => {
      const receipt = new Receipt ({
        id: 'receipt',
        totalReceived: Long.fromNumber(10),
        streamStartTime
      })
      const value = await redis.getReceiptValue(receipt)
      expect(value.compare(receipt.totalReceived)).toBe(0)
    })

    it('sets stored receipt amount', async () => {
      const receipt = new Receipt ({
        id: 'receipt',
        totalReceived: Long.fromNumber(10),
        streamStartTime
      })
      const key = `${RECEIPT_KEY}:${receipt.id}`
      expect(await redis._redis.get(key)).toBeNull()
      await redis.getReceiptValue(receipt)
      const ret = await redis._redis.get(key)
      expect(await redis._redis.get(key)).toBe(receipt.totalReceived.toString())
    })

    it('returns the incremented amount of a subsequent receipt', async () => {
      const receipt1 = new Receipt ({
        id: 'receipt',
        totalReceived: Long.fromNumber(10),
        streamStartTime
      })
      const receipt2 = new Receipt ({
        id: receipt1.id,
        totalReceived: Long.fromNumber(15),
        streamStartTime
      })
      await redis.getReceiptValue(receipt1)
      const value = await redis.getReceiptValue(receipt2)
      expect(value.compare(5)).toBe(0)
    })

    it('increases stored receipt amount', async () => {
      const receipt1 = new Receipt ({
        id: 'receipt',
        totalReceived: Long.fromNumber(10),
        streamStartTime
      })
      const receipt2 = new Receipt ({
        id: receipt1.id,
        totalReceived: Long.fromNumber(15),
        streamStartTime
      })
      const key = `${RECEIPT_KEY}:${receipt1.id}`
      expect(await redis._redis.get(key)).toBeNull()
      await redis.getReceiptValue(receipt1)
      expect(await redis._redis.get(key)).toBe(receipt1.totalReceived.toString())
      await redis.getReceiptValue(receipt2)
      expect(await redis._redis.get(key)).toBe(receipt2.totalReceived.toString())
    })

    it('returns zero for receipt with lower amount', async () => {
      const receipt1 = new Receipt ({
        id: 'receipt',
        totalReceived: Long.fromNumber(10),
        streamStartTime
      })
      const receiptLess = new Receipt ({
        id: receipt1.id,
        totalReceived: Long.fromNumber(5),
        streamStartTime
      })
      await redis.getReceiptValue(receipt1)
      const value = await redis.getReceiptValue(receiptLess)
      expect(value.compare(0)).toBe(0)
    })

    it('won\'t decrease stored receipt amount', async () => {
      const receipt1 = new Receipt ({
        id: 'receipt',
        totalReceived: Long.fromNumber(10),
        streamStartTime
      })
      const receiptOld = new Receipt ({
        id: receipt1.id,
        totalReceived: Long.fromNumber(5),
        streamStartTime
      })
      const key = `${RECEIPT_KEY}:${receipt1.id}`
      expect(await redis._redis.get(key)).toBeNull()
      await redis.getReceiptValue(receipt1)
      expect(await redis._redis.get(key)).toBe(receipt1.totalReceived.toString())
      await redis.getReceiptValue(receiptOld)
      expect(await redis._redis.get(key)).toBe(receipt1.totalReceived.toString())
    })

    it('throws for receipt amount greater than max 64 bit signed int', async () => {
      const receiptSafe = new Receipt ({
        id: 'receipt',
        totalReceived: Long.MAX_VALUE.toUnsigned(),
        streamStartTime
      })
      const receiptBig = new Receipt ({
        id: receiptSafe.id,
        totalReceived: receiptSafe.totalReceived.add(1),
        streamStartTime
      })
      await redis.getReceiptValue(receiptSafe)
      try {
        await redis.getReceiptValue(receiptBig)
        fail()
      } catch (error) {
        expect(error.message).toBe('receipt amount exceeds max 64 bit signed integer')
      }
    })

    it('returns zero for expired receipt', async () => {
      const oldStreamTime = Math.floor(Date.now()/1000) - config.receiptTTLSeconds

      const receipt = new Receipt ({
        id: 'receipt',
        totalReceived: Long.fromNumber(10),
        streamStartTime: Long.fromNumber(oldStreamTime, true)
      })
      const value = await redis.getReceiptValue(receipt)
      expect(value.compare(0)).toBe(0)
    })

    it('sets stored receipt expiration', async () => {
      const receipt = new Receipt ({
        id: 'receipt',
        totalReceived: Long.fromNumber(10),
        streamStartTime
      })
      const key = `${RECEIPT_KEY}:${receipt.id}`
      const ttlMax = receipt.getRemainingTTL(config.receiptTTLSeconds)
      await redis.getReceiptValue(receipt)
      const ttl = await redis._redis.ttl(key)
      const ttlMin = receipt.getRemainingTTL(config.receiptTTLSeconds)
      expect(ttl).toBeLessThanOrEqual(ttlMax)
      expect(ttl).toBeGreaterThanOrEqual(ttlMin)
    })
  })

  describe('creditBalance', () => {
    it('returns new balance', async () => {
      const id = 'id'
      const amount = Long.fromNumber(10)
      const key = `${BALANCE_KEY}:${id}`
      const balance = await redis.creditBalance(id, amount)
      expect(balance.compare(amount)).toBe(0)
    })

    it('returns updated balance', async () => {
      const id = 'id'
      const amount = Long.fromNumber(10)
      const key = `${BALANCE_KEY}:${id}`
      let balance = await redis.creditBalance(id, amount)
      expect(balance.compare(amount)).toBe(0)
      balance = await redis.creditBalance(id, amount)
      expect(balance.compare(amount.add(amount))).toBe(0)
    })

    it('creates new balance', async () => {
      const id = 'id'
      const amount = Long.fromNumber(10)
      const key = `${BALANCE_KEY}:${id}`
      expect(await redis._redis.get(key)).toBeNull()
      await redis.creditBalance(id, amount)
      expect(await redis._redis.get(key)).toBe(amount.toString())
    })

    it('increases balance', async () => {
      const id = 'id'
      const key = `${BALANCE_KEY}:${id}`
      await redis.creditBalance(id, Long.fromNumber(10))
      expect(await redis._redis.get(key)).toBe('10')
      await redis.creditBalance(id, Long.fromNumber(5))
      expect(await redis._redis.get(key)).toBe('15')
    })

    it('throws for negative credit amount', async () => {
      const id = 'id'
      const amount = Long.fromNumber(-1)
      try {
        await redis.creditBalance(id, amount)
        fail()
      } catch (error) {
        expect(error.message).toBe('credit amount must not be negative')
      }
    })

    it('throws for credit amount greater than max 64 bit signed integer', async () => {
      const id = 'id'
      const amountSafe = Long.MAX_VALUE.toUnsigned()
      const amountBig = amountSafe.add(1)
      await redis.creditBalance(id, amountSafe)
      try {
        await redis.creditBalance(id, amountBig)
        fail()
      } catch (error) {
        expect(error.message).toBe('credit amount exceeds max 64 bit signed integer')
      }
    })

    it('throws for balance greater than max 64 bit signed integer', async () => {
      const id = 'id'
      const one = Long.fromNumber(1)
      const key = `${BALANCE_KEY}:${id}`
      await redis._redis.set(key, Long.MAX_VALUE.subtract(1).toString())  // max int64 - 1
      await redis.creditBalance(id, one)                                  // max int64
      try {
        await redis.creditBalance(id, one)                                // max int64 + 1
        // ioredit-mock won't throw
        fail()
      } catch (error) {
        expect(error.message).toBe('balance cannot exceed max 64 bit signed integer')
      }
    })
  })

  describe('spendBalance', () => {
    it('returns new balance when balance is sufficient', async () => {
      const id = 'id'
      await redis.creditBalance(id, Long.fromNumber(10))
      const balance = await redis.spendBalance(id, Long.fromNumber(1))
      expect(balance.compare(9)).toBe(0)
    })

    it('throws when balance doesn\'t exist', async () => {
      const id = 'id'
      try {
        await redis.spendBalance(id, Long.fromNumber(10))
        // ioredit-mock won't throw
        fail()
      } catch (error) {
        expect(error.message).toBe('balance does not exist')
      }
    })

    it('throws when balance is insufficient', async () => {
      const id = 'id'
      await redis.creditBalance(id, Long.fromNumber(5))
      try {
        await redis.spendBalance(id, Long.fromNumber(10))
        // ioredit-mock won't throw
        fail()
      } catch (error) {
        expect(error.message).toBe('insufficient balance')
      }
    })

    it('won\'t create balance', async () => {
      const id = 'id'
      const key = `${BALANCE_KEY}:${id}`
      expect(await redis._redis.get(key)).toBeNull()
      try {
        await redis.spendBalance(id, Long.fromNumber(10))
        fail()
      } catch (error) {
        expect(await redis._redis.get(key)).toBeNull()
      }
    })

    it('won\'t decrease balance when balance is insuffient', async () => {
      const id = 'id'
      const key = `${BALANCE_KEY}:${id}`
      await redis.creditBalance(id, Long.fromNumber(5))
      expect(await redis._redis.get(key)).toBe('5')
      try {
        await redis.spendBalance(id, Long.fromNumber(10))
        fail()
      } catch (error) {
        expect(await redis._redis.get(key)).toBe('5')
      }
    })

    it('decreases balance', async () => {
      const id = 'id'
      const key = `${BALANCE_KEY}:${id}`
      await redis.creditBalance(id, Long.fromNumber(10))
      expect(await redis._redis.get(key)).toBe('10')
      let balance = await redis.spendBalance(id, Long.fromNumber(1))
      expect(balance.compare(9)).toBe(0)
      expect(await redis._redis.get(key)).toBe('9')
      balance = await redis.spendBalance(id, Long.fromNumber(2))
      expect(balance.compare(7)).toBe(0)
      expect(await redis._redis.get(key)).toBe('7')
    })

    it('throws for negative spend amount', async () => {
      const id = 'id'
      const amount = Long.fromNumber(-1)
      await redis.creditBalance(id, Long.fromNumber(10))
      try {
        await redis.spendBalance(id, amount)
        fail()
      } catch (error) {
        expect(error.message).toBe('spend amount must not be negative')
      }
    })

    it('throws for spend amount greater than max 64 bit signed integer', async () => {
      const id = 'id'
      const amountBig = Long.MAX_VALUE.toUnsigned().add(1)
      await redis.creditBalance(id, Long.fromNumber(10))
      try {
        await redis.spendBalance(id, amountBig)
        fail()
      } catch (error) {
        expect(error.message).toBe('spend amount exceeds max 64 bit signed integer')
      }
    })
  })
})
