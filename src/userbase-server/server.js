import path from 'path'
import expressLogger from 'express-pino-logger'
import WebSocket from 'ws'
import http from 'http'
import https from 'https'

import bodyParser from 'body-parser'
import cookieParser from 'cookie-parser'
import logger from './logger'
import setup from './setup'
import admin from './admin'
import user from './user'
import db from './db'
import appController from './app'
import connections from './ws'
import statusCodes from './statusCodes'
import responseBuilder from './responseBuilder'

const adminPanelDir = '/admin-panel/dist'

const ONE_KB = 1024

// DynamoDB single item limit: https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Limits.html#limits-items
const FOUR_HUNDRED_KB = 400 * ONE_KB

const HSTS_MAX_AGE = 63072000 // 2 years

if (process.env.NODE_ENV == 'development') {
  logger.warn('Development Mode')
}

async function start(express, app, userbaseConfig = {}) {
  try {
    const {
      httpsKey,
      httpsCert,
      stripeRedirectUrl
    } = userbaseConfig

    if (stripeRedirectUrl) process.env['STRIPE_REDIRECT_URL'] = stripeRedirectUrl

    await setup.init(userbaseConfig)

    const certExists = httpsKey && httpsCert
    const httpPort = userbaseConfig.httpPort || 8080
    const httpsPort = userbaseConfig.httpsPort || 8443

    const server = certExists ?
      https.createServer({ key: httpsKey, cert: httpsCert }, app)
        .listen(httpsPort, () => logger.info(`App listening on https port ${httpsPort}....`)) :
      http.createServer(app)
        .listen(httpPort, () => logger.info(`App listening on http port ${httpPort}....`))

    const wss = new WebSocket.Server({ noServer: true })

    server.on('upgrade', (req, socket, head) => {
      const res = new http.ServerResponse(req)
      res.assignSocket(socket)
      res.on('finish', () => res.socket.destroy())
      req.ws = true
      res.ws = fn => wss.handleUpgrade(req, socket, head, fn)
      app(req, res)
    })

    const heartbeat = function (ws) {
      ws.isAlive = true
    }

    wss.on('connection', (ws, req, res) => {
      ws.isAlive = true
      const userId = res.locals.user['user-id']
      const userPublicKey = res.locals.user['public-key']
      const adminId = res.locals.admin['admin-id']

      const clientId = req.query.clientId

      const conn = connections.register(userId, ws, clientId, adminId)
      if (conn) {
        const connectionId = conn.id

        const { validationMessage, encryptedValidationMessage } = user.getValidationMessage(userPublicKey)

        logger.child({ wsRes: { userId, connectionId, adminId, route: 'Connection' } }).info()
        ws.send(JSON.stringify({
          route: 'Connection',
          keySalts: {
            encryptionKeySalt: res.locals.user['encryption-key-salt'],
            dhKeySalt: res.locals.user['diffie-hellman-key-salt'],
            hmacKeySalt: res.locals.user['hmac-key-salt'],
          },
          encryptedValidationMessage
        }))

        ws.on('close', () => connections.close(conn))

        ws.on('message', async (msg) => {
          ws.isAlive = true

          try {
            if (msg.length > FOUR_HUNDRED_KB || msg.byteLength > FOUR_HUNDRED_KB) {
              logger.child({ wsRes: { userId, connectionId, adminId, size: msg.length } }).error('Received large message')
              return ws.send('Message is too large')
            }

            const request = JSON.parse(msg)

            const requestId = request.requestId
            const action = request.action
            const params = request.params

            let response

            if (action === 'Pong') {
              heartbeat(ws)
              return
            }

            logger.child({ wsReq: { userId, connectionId, adminId, requestId, action, size: msg.length } }).info()

            if (conn.rateLimiter.atCapacity()) {

              response = responseBuilder.errorResponse(statusCodes['Too Many Requests'], { retryDelay: 1000 })

            } else {

              if (action === 'SignOut') {
                response = await user.signOut(params.sessionId)
              } else if (!conn.keyValidated) {

                switch (action) {
                  case 'ValidateKey': {
                    response = await user.validateKey(
                      validationMessage,
                      params.validationMessage,
                      res.locals.user,
                      conn
                    )
                    break
                  }
                  default: {
                    response = responseBuilder.errorResponse(statusCodes['Unauthorized'], 'Key not validated')
                  }
                }

              } else {

                switch (action) {
                  case 'ValidateKey': {
                    response = responseBuilder.errorResponse(statusCodes['Bad Request'], 'Already validated key')
                    break
                  }
                  case 'UpdateUser': {
                    response = await user.updateUser(
                      userId,
                      params.username,
                      params.currentPasswordToken,
                      params.passwordToken,
                      params.passwordSalts,
                      params.email,
                      params.profile,
                      params.passwordBasedBackup
                    )
                    break
                  }
                  case 'DeleteUser': {
                    response = await user.deleteUserController(
                      userId,
                      adminId,
                      res.locals.app['app-name']
                    )
                    break
                  }
                  case 'OpenDatabase': {
                    response = await db.openDatabase(
                      userId,
                      connectionId,
                      params.dbNameHash,
                      params.newDatabaseParams,
                      params.reopenAtSeqNo
                    )
                    break
                  }
                  case 'Insert':
                  case 'Update':
                  case 'Delete': {
                    response = await db.doCommand(
                      action,
                      userId,
                      params.dbNameHash,
                      params.dbId,
                      params.itemKey,
                      params.encryptedItem
                    )
                    break
                  }
                  case 'BatchTransaction': {
                    response = await db.batchTransaction(userId, params.dbNameHash, params.dbId, params.operations)
                    break
                  }
                  case 'Bundle': {
                    response = await db.bundleTransactionLog(params.dbId, params.seqNo, params.bundle)
                    break
                  }
                  case 'GetPasswordSalts': {
                    response = await user.getPasswordSaltsByUserId(userId)
                    break
                  }
                  default: {
                    logger
                      .child({ wsRes: { userId, connectionId, adminId, route: action, requestId, statusCode: response.status, size: msg.length } })
                      .error('Received unknown action')
                    return ws.send(`Received unkown action ${action}`)
                  }
                }
              }
            }

            const responseMsg = JSON.stringify({
              requestId,
              response,
              route: action
            })

            logger
              .child({
                wsRes: {
                  userId,
                  connectionId,
                  adminId,
                  route: action,
                  requestId,
                  statusCode: response.status,
                  size: responseMsg.length
                }
              })
              .info()

            ws.send(responseMsg)

          } catch (e) {
            logger
              .child({ userId, connectionId, adminId, errorName: e.name, errorMessage: e.message })
              .error(`Error in Websocket handling the following message: ${msg}`)
          }

        })
      }
    })

    setInterval(function ping() {
      wss.clients.forEach(ws => {
        if (ws.isAlive === false) return ws.terminate()

        ws.isAlive = false
        ws.send(JSON.stringify({ route: 'Ping' }))
      })
    }, 30000)

    // browsers will cache setting to use https for all future requests to server
    app.use(function (req, res, next) {
      res.setHeader('Strict-Transport-Security', `max-age: ${HSTS_MAX_AGE}; includeSubDomains; preload`)
      next()
    })

    app.use(expressLogger({ logger }))
    app.get('/ping', function (req, res) {
      res.send('Healthy')
    })

    // Userbase user API
    const v1Api = express.Router()
    app.use('/v1/api', v1Api)

    v1Api.use(bodyParser.json())

    v1Api.get('/', user.authenticateUser, (req, res) =>
      req.ws
        ? res.ws(socket => wss.emit('connection', socket, req, res))
        : res.send('Not a websocket!')
    )
    v1Api.post('/auth/sign-up', user.signUp)
    v1Api.post('/auth/sign-in', user.signIn)
    v1Api.post('/auth/sign-in-with-session', user.authenticateUser, user.extendSession)
    v1Api.get('/auth/server-public-key', user.getServerPublicKey)
    v1Api.get('/auth/get-password-salts', user.getPasswordSaltsController)

    // Userbase admin API
    app.use(express.static(path.join(__dirname + adminPanelDir)))
    const v1Admin = express.Router()
    app.use('/v1/admin', v1Admin)

    v1Admin.use(cookieParser())

    v1Admin.post('/stripe/webhook', bodyParser.raw({ type: 'application/json' }), admin.handleStripeWebhook)

    // must come after stripe/webhook to ensure parsing done correctly
    v1Admin.use(bodyParser.json())

    v1Admin.post('/create-admin', admin.createAdminController)
    v1Admin.post('/sign-in', admin.signInAdmin)
    v1Admin.post('/sign-out', admin.authenticateAdmin, admin.signOutAdmin)
    v1Admin.post('/create-app', admin.authenticateAdmin, admin.getSaasSubscriptionController, appController.createAppController)
    v1Admin.post('/list-apps', admin.authenticateAdmin, appController.listApps)
    v1Admin.post('/list-app-users', admin.authenticateAdmin, appController.listAppUsers)
    v1Admin.post('/delete-app', admin.authenticateAdmin, admin.getSaasSubscriptionController, appController.deleteApp)
    v1Admin.post('/permanent-delete-app', admin.authenticateAdmin, admin.getSaasSubscriptionController, appController.permanentDeleteApp)
    v1Admin.post('/delete-user', admin.authenticateAdmin, admin.deleteUser)
    v1Admin.post('/permanent-delete-user', admin.authenticateAdmin, admin.permanentDeleteUser)
    v1Admin.post('/delete-admin', admin.authenticateAdmin, admin.getSaasSubscriptionController, admin.deleteAdmin)
    v1Admin.post('/update-admin', admin.authenticateAdmin, admin.updateAdmin)
    v1Admin.post('/change-password', admin.authenticateAdmin, admin.changePassword)
    v1Admin.post('/forgot-password', admin.forgotPassword)
    v1Admin.get('/payment-status', admin.authenticateAdmin, admin.getSaasSubscriptionController, (req, res) => {
      const subscription = res.locals.subscription
      if (!subscription) return res.end()
      return res.send(subscription.cancel_at_period_end ? 'cancel_at_period_end' : subscription.status)
    })

    v1Admin.post('/stripe/create-saas-payment-session', admin.authenticateAdmin, admin.createSaasPaymentSession)
    v1Admin.post('/stripe/update-saas-payment-session', admin.authenticateAdmin, admin.getSaasSubscriptionController, admin.updateSaasSubscriptionPaymentSession)
    v1Admin.post('/stripe/cancel-saas-subscription', admin.authenticateAdmin, admin.getSaasSubscriptionController, admin.cancelSaasSubscription)
    v1Admin.post('/stripe/resume-saas-subscription', admin.authenticateAdmin, admin.getSaasSubscriptionController, admin.resumeSaasSubscription)

  } catch (e) {
    logger.info(`Unhandled error while launching server: ${e}`)
  }
}

function createAdmin({ email, password, fullName, adminId, receiveEmailUpdates, storePasswordInSecretsManager = false }) {
  return admin.createAdmin(email, password, fullName, adminId, receiveEmailUpdates, storePasswordInSecretsManager)
}

function createApp({ appName, adminId, appId }) {
  return appController.createApp(appName, adminId, appId)
}

export default {
  start,
  createAdmin,
  createApp
}
