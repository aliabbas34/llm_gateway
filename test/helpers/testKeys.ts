/**
 * TEST-ONLY Ed25519 key pairs. Used only by the test suite; they protect nothing.
 * OTHER_* is a second pair, for "signed by the wrong key" tests.
 */
export const TEST_PRIVATE_KEY_PEM =
  '-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEILv8XnddoewCEU3t+9ETM96KCjEuaIILKwCvZ3DAtNMU\n-----END PRIVATE KEY-----';

export const TEST_PUBLIC_KEY_PEM =
  '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEANt3oL+xxYvn38Hdmryfh6/Z45BEkEYN7bPfkrrg3zo4=\n-----END PUBLIC KEY-----';

export const OTHER_PRIVATE_KEY_PEM =
  '-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIN920ze8wuAUqr/Rsayn2x05i2DeN8DtB9rQJrv4UesJ\n-----END PRIVATE KEY-----';
