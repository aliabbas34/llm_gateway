--[[
  Settle a reservation: charge min(actual, reserved) and refund the rest (FR5).
  Used for reconcile (actual = tokens consumed) and release (actual = 0).

  Idempotent: the reservation field is deleted in the same atomic step as the refund, so a second
  call (a retry, or racing the sweeper) finds nothing and returns 'already_settled'.

  KEYS[1] budget   KEYS[2] reservations (hash)
  ARGV[1] reservation id   ARGV[2] actual tokens
  Returns {'settled', reserved, charged, remaining} | {'already_settled'}
]]
local raw = redis.call('HGET', KEYS[2], ARGV[1])
if not raw then
  return { 'already_settled' }
end

local r = cjson.decode(raw)
local reserved = tonumber(r.r)
local actual = math.max(0, tonumber(ARGV[2]))
local charged = math.min(actual, reserved)
local refund = reserved - charged

redis.call('HDEL', KEYS[2], ARGV[1])
local remaining = 0
-- Only refund into a budget that still exists: never create one from a refund.
if redis.call('EXISTS', KEYS[1]) == 1 then
  remaining = redis.call('INCRBY', KEYS[1], refund)
end
return { 'settled', reserved, charged, remaining }
