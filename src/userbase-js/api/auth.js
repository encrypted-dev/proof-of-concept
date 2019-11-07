import axios from 'axios'
import config from '../config'

const TEN_SECONDS_MS = 10 * 1000

const signUp = async (username, password, publicKey, encryptionKeySalt, dhKeySalt, hmacKeySalt, email, profile) => {
  const signUpResponse = await axios({
    method: 'POST',
    url: `${config.getEndpoint()}/api/auth/sign-up?appId=${config.getAppId()}`,
    data: {
      username,
      password,
      publicKey,
      encryptionKeySalt,
      dhKeySalt,
      hmacKeySalt,
      email,
      profile
    },
    timeout: TEN_SECONDS_MS
  })

  return signUpResponse.data
}

const signIn = async (username, password) => {
  const signInResponse = await axios({
    method: 'POST',
    url: `${config.getEndpoint()}/api/auth/sign-in?appId=${config.getAppId()}`,
    data: {
      username,
      password
    },
    timeout: TEN_SECONDS_MS
  })

  return signInResponse.data
}

const signInWithSession = async (sessionId) => {
  const signInWithSessionResponse = await axios({
    method: 'POST',
    url: `${config.getEndpoint()}/api/auth/sign-in-with-session?appId=${config.getAppId()}&sessionId=${sessionId}`,
    timeout: TEN_SECONDS_MS
  })

  return signInWithSessionResponse.data
}

const getServerPublicKey = async () => {
  const serverPublicKeyResponse = await axios({
    method: 'GET',
    url: `${config.getEndpoint()}/api/auth/server-public-key`,
    timeout: TEN_SECONDS_MS,
    responseType: 'arraybuffer'
  })

  const serverPublicKey = serverPublicKeyResponse.data
  return serverPublicKey
}

export default {
  signUp,
  signIn,
  signInWithSession,
  getServerPublicKey
}
