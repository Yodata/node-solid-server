'use strict'

const url = require('url')
const path = require('path')
const rdf = require('rdflib')
const ns = require('solid-namespace')(rdf)

const defaults = require('../../config/defaults')
const UserAccount = require('./user-account')
const AccountTemplate = require('./account-template')
const debug = require('./../debug').accounts

const DEFAULT_PROFILE_CONTENT_TYPE = 'text/turtle'
const DEFAULT_ADMIN_USERNAME = 'admin'

/**
 * Manages account creation (determining whether accounts exist, creating
 * directory structures for new accounts, saving credentials).
 *
 * @class AccountManager
 */
class AccountManager {
  /**
   * @constructor
   * @param [options={}] {Object}
   * @param [options.authMethod] {string} Primary authentication method (e.g. 'oidc')
   * @param [options.emailService] {EmailService}
   * @param [options.tokenService] {TokenService}
   * @param [options.host] {SolidHost}
   * @param [options.multiuser=false] {boolean} (argv.multiuser) Is the server running
   *   in multiuser mode (users can sign up for accounts) or single user
   *   (such as a personal website).
   * @param [options.store] {LDP}
   * @param [options.pathCard] {string}
   * @param [options.suffixURI] {string}
   * @param [options.accountTemplatePath] {string} Path to the account template
   *   directory (will be used as a template for default containers, etc, when
   *   creating new accounts).
   */
  constructor (options = {}) {
    if (!options.host) {
      throw Error('AccountManager requires a host instance')
    }
    this.host = options.host
    this.emailService = options.emailService
    this.tokenService = options.tokenService
    this.authMethod = options.authMethod || defaults.auth
    this.multiuser = options.multiuser || false
    this.store = options.store
    this.pathCard = options.pathCard || 'profile/card'
    this.suffixURI = options.suffixURI || '#me'
    this.accountTemplatePath = options.accountTemplatePath || './default-templates/new-account/'
  }

  /**
   * Factory method for new account manager creation. Usage:
   *
   *   ```
   *   let options = { host, multiuser, store }
   *   let accontManager = AccountManager.from(options)
   *   ```
   *
   * @param [options={}] {Object} See the `constructor()` docstring.
   *
   * @return {AccountManager}
   */
  static from (options) {
    return new AccountManager(options)
  }

  /**
   * Tests whether an account already exists for a given username.
   * Usage:
   *
   *   ```
   *   accountManager.accountExists('alice')
   *     .then(exists => {
   *       console.log('answer: ', exists)
   *     })
   *   ```
   * @param accountName {string} Account username, e.g. 'alice'
   *
   * @return {Promise<boolean>}
   */
  accountExists (accountName) {
    let accountUri
    let rootAclPath

    try {
      accountUri = this.accountUriFor(accountName)
      accountUri = url.parse(accountUri).hostname

      rootAclPath = url.resolve('/', this.store.suffixAcl)
    } catch (err) {
      return Promise.reject(err)
    }

    return this.accountUriExists(accountUri, rootAclPath)
  }

  /**
   * Tests whether a given account URI (e.g. 'https://alice.example.com/')
   * already exists on the server.
   *
   * @param accountUri {string}
   * @param accountResource {string}
   *
   * @return {Promise<boolean>}
   */
  accountUriExists (accountUri, accountResource = '/') {
    return new Promise((resolve, reject) => {
      this.store.exists(accountUri, accountResource, (err, result) => {
        if (err && err.status === 404) {
          return resolve(false)
        }

        resolve(!!result)
      })
    })
  }

  /**
   * Constructs a directory path for a given account (used for account creation).
   * Usage:
   *
   *   ```
   *   // If solid-server was launched with '/accounts/' as the root directory
   *   // and serverUri: 'https://example.com'
   *
   *   accountManager.accountDirFor('alice')  // -> '/accounts/alice.example.com'
   *   ```
   *
   * @param accountName {string}
   *
   * @return {string}
   */
  accountDirFor (accountName) {
    let accountDir

    if (this.multiuser) {
      let uri = this.accountUriFor(accountName)
      let hostname = url.parse(uri).hostname
      accountDir = path.join(this.store.root, hostname)
    } else {
      // single user mode
      accountDir = this.store.root
    }
    return accountDir
  }

  /**
   * Composes an account URI for a given account name.
   * Usage (given a host with serverUri of 'https://example.com'):
   *
   *   ```
   *   // in multi user mode:
   *   acctMgr.accountUriFor('alice')
   *   // -> 'https://alice.example.com'
   *
   *   // in single user mode:
   *   acctMgr.accountUriFor()
   *   // -> 'https://example.com'
   *   ```
   *
   * @param [accountName] {string}
   *
   * @throws {Error} If `this.host` has not been initialized with serverUri,
   *   or if in multiuser mode and accountName is not provided.
   * @return {string}
   */
  accountUriFor (accountName) {
    let accountUri = this.multiuser
      ? this.host.accountUriFor(accountName)
      : this.host.serverUri  // single user mode

    return accountUri
  }

  /**
   * Composes a WebID (uri with hash fragment) for a given account name.
   * Usage:
   *
   *   ```
   *   // in multi user mode:
   *   acctMgr.accountWebIdFor('alice')
   *   // -> 'https://alice.example.com/profile/card#me'
   *
   *   // in single user mode:
   *   acctMgr.accountWebIdFor()
   *   // -> 'https://example.com/profile/card#me'
   *   ```
   *
   * @param [accountName] {string}
   *
   * @throws {Error} via accountUriFor()
   *
   * @return {string|null}
   */
  accountWebIdFor (accountName) {
    let accountUri = this.accountUriFor(accountName)

    let webIdUri = url.parse(url.resolve(accountUri, this.pathCard))
    webIdUri.hash = this.suffixURI
    return webIdUri.format()
  }

  /**
   * Returns the root .acl URI for a given user account (the account recovery
   * email is stored there).
   *
   * @param userAccount {UserAccount}
   *
   * @throws {Error} via accountUriFor()
   *
   * @return {string} Root .acl URI
   */
  rootAclFor (userAccount) {
    let accountUri = this.accountUriFor(userAccount.username)

    return url.resolve(accountUri, this.store.suffixAcl)
  }

  /**
   * Adds a newly generated WebID-TLS certificate to the user's profile graph.
   *
   * @param certificate {WebIdTlsCertificate}
   * @param userAccount {UserAccount}
   *
   * @return {Promise<Graph>}
   */
  addCertKeyToProfile (certificate, userAccount) {
    if (!certificate) {
      throw new TypeError('Cannot add empty certificate to user profile')
    }

    return this.getProfileGraphFor(userAccount)
      .then(profileGraph => {
        return this.addCertKeyToGraph(certificate, profileGraph)
      })
      .then(profileGraph => {
        return this.saveProfileGraph(profileGraph, userAccount)
      })
  }

  /**
   * Returns a parsed WebID Profile graph for a given user account.
   *
   * @param userAccount {UserAccount}
   * @param [contentType] {string} Content type of the profile to parse
   *
   * @throws {Error} If the user account's WebID is missing
   * @throws {Error} HTTP 404 error (via `getGraph()`) if the profile resource
   *   is not found
   *
   * @return {Promise<Graph>}
   */
  getProfileGraphFor (userAccount, contentType = DEFAULT_PROFILE_CONTENT_TYPE) {
    let webId = userAccount.webId
    if (!webId) {
      let error = new Error('Cannot fetch profile graph, missing WebId URI')
      error.status = 400
      return Promise.reject(error)
    }

    let uri = userAccount.profileUri

    return this.store.getGraph(uri, contentType)
      .catch(error => {
        error.message = `Error retrieving profile graph ${uri}: ` + error.message
        throw error
      })
  }

  /**
   * Serializes and saves a given graph to the user's WebID Profile (and returns
   * the original graph object, as it was before serialization).
   *
   * @param profileGraph {Graph}
   * @param userAccount {UserAccount}
   * @param [contentType] {string}
   *
   * @return {Promise<Graph>}
   */
  saveProfileGraph (profileGraph, userAccount, contentType = DEFAULT_PROFILE_CONTENT_TYPE) {
    let webId = userAccount.webId
    if (!webId) {
      let error = new Error('Cannot save profile graph, missing WebId URI')
      error.status = 400
      return Promise.reject(error)
    }

    let uri = userAccount.profileUri

    return this.store.putGraph(profileGraph, uri, contentType)
  }

  /**
   * Adds the certificate's Public Key related triples to a user's profile graph.
   *
   * @param certificate {WebIdTlsCertificate}
   * @param graph {Graph} Parsed WebID Profile graph
   *
   * @return {Graph}
   */
  addCertKeyToGraph (certificate, graph) {
    let webId = rdf.namedNode(certificate.webId)
    let key = rdf.namedNode(certificate.keyUri)
    let timeCreated = rdf.literal(certificate.date.toISOString(), ns.xsd('dateTime'))
    let modulus = rdf.literal(certificate.modulus, ns.xsd('hexBinary'))
    let exponent = rdf.literal(certificate.exponent, ns.xsd('int'))
    let title = rdf.literal('Created by solid-server')
    let label = rdf.literal(certificate.commonName)

    graph.add(webId, ns.cert('key'), key)
    graph.add(key, ns.rdf('type'), ns.cert('RSAPublicKey'))
    graph.add(key, ns.dct('title'), title)
    graph.add(key, ns.rdfs('label'), label)
    graph.add(key, ns.dct('created'), timeCreated)
    graph.add(key, ns.cert('modulus'), modulus)
    graph.add(key, ns.cert('exponent'), exponent)

    return graph
  }

  /**
   * Creates and returns a `UserAccount` instance from submitted user data
   * (typically something like `req.body`, from a signup form).
   *
   * @param userData {Object} Options hashmap, like `req.body`.
   *   Either a `username` or a `webid` property is required.
   *
   * @param [userData.username] {string}
   * @param [uesrData.webid] {string}
   *
   * @param [userData.email] {string}
   * @param [userData.name] {string}
   *
   * @throws {Error} (via `accountWebIdFor()`) If in multiuser mode and no
   *   username passed
   *
   * @return {UserAccount}
   */
  userAccountFrom (userData) {
    let userConfig = {
      username: userData.username,
      email: userData.email,
      name: userData.name,
      externalWebId: userData.externalWebId,
      localAccountId: userData.localAccountId,
      webId: userData.webid || userData.webId || userData.externalWebId
    }

    try {
      userConfig.webId = userConfig.webId || this.accountWebIdFor(userConfig.username)
    } catch (err) {
      if (err.message === 'Cannot construct uri for blank account name') {
        throw new Error('Username or web id is required')
      } else {
        throw err
      }
    }

    if (userConfig.username) {
      if (userConfig.externalWebId && !userConfig.localAccountId) {
        // External Web ID exists, derive the local account id from username
        userConfig.localAccountId = this.accountWebIdFor(userConfig.username)
          .split('//')[1]  // drop the https://
      }
    } else {  // no username - derive it from web id
      if (userConfig.externalWebId) {
        userConfig.username = userConfig.externalWebId
      } else {
        userConfig.username = this.usernameFromWebId(userConfig.webId)
      }
    }

    return UserAccount.from(userConfig)
  }

  usernameFromWebId (webId) {
    if (!this.multiuser) {
      return DEFAULT_ADMIN_USERNAME
    }

    let profileUrl = url.parse(webId)
    let hostname = profileUrl.hostname

    return hostname.split('.')[0]
  }

  /**
   * Creates a user account storage folder (from a default account template).
   *
   * @param userAccount {UserAccount}
   *
   * @return {Promise}
   */
  createAccountFor (userAccount) {
    let template = AccountTemplate.for(userAccount)

    let templatePath = this.accountTemplatePath
    let accountDir = this.accountDirFor(userAccount.username)

    debug(`Creating account folder for ${userAccount.webId} at ${accountDir}`)

    return AccountTemplate.copyTemplateDir(templatePath, accountDir)
      .then(() => {
        return template.processAccount(accountDir)
      })
  }

  /**
   * Generates an expiring one-time-use token for password reset purposes
   * (the user's Web ID is saved in the token service).
   *
   * @param userAccount {UserAccount}
   *
   * @return {string} Generated token
   */
  generateResetToken (userAccount) {
    return this.tokenService.generate({ webId: userAccount.webId })
  }

  /**
   * Validates that a token exists and is not expired, and returns the saved
   * token contents, or throws an error if invalid.
   * Does not consume / clear the token.
   *
   * @param token {string}
   *
   * @throws {Error} If missing or invalid token
   *
   * @return {Object|false} Saved token data object if verified, false otherwise
   */
  validateResetToken (token) {
    let tokenValue = this.tokenService.verify(token)

    if (!tokenValue) {
      throw new Error('Invalid or expired reset token')
    }

    return tokenValue
  }

  /**
   * Returns a password reset URL (to be emailed to the user upon request)
   *
   * @param token {string} One-time-use expiring token, via the TokenService
   * @param returnToUrl {string}
   *
   * @return {string}
   */
  passwordResetUrl (token, returnToUrl) {
    let resetUrl = url.resolve(this.host.serverUri,
      `/account/password/change?token=${token}`)

    if (returnToUrl) {
      resetUrl += `&returnToUrl=${returnToUrl}`
    }

    return resetUrl
  }

  /**
   * Parses and returns an account recovery email stored in a user's root .acl
   *
   * @param userAccount {UserAccount}
   *
   * @return {Promise<string|undefined>}
   */
  loadAccountRecoveryEmail (userAccount) {
    return Promise.resolve()
      .then(() => {
        let rootAclUri = this.rootAclFor(userAccount)

        return this.store.getGraph(rootAclUri)
      })
      .then(rootAclGraph => {
        let matches = rootAclGraph.match(null, ns.acl('agent'))

        let recoveryMailto = matches.find(agent => {
          return agent.object.value.startsWith('mailto:')
        })

        if (recoveryMailto) {
          recoveryMailto = recoveryMailto.object.value.replace('mailto:', '')
        }

        return recoveryMailto
      })
  }

  sendPasswordResetEmail (userAccount, returnToUrl) {
    return Promise.resolve()
      .then(() => {
        if (!this.emailService) {
          throw new Error('Email service is not set up')
        }

        if (!userAccount.email) {
          throw new Error('Account recovery email has not been provided')
        }

        return this.generateResetToken(userAccount)
      })
      .then(resetToken => {
        let resetUrl = this.passwordResetUrl(resetToken, returnToUrl)

        let emailData = {
          to: userAccount.email,
          webId: userAccount.webId,
          resetUrl
        }

        return this.emailService.sendWithTemplate('reset-password', emailData)
      })
  }

  /**
   * Sends a Welcome email (on new user signup).
   *
   * @param newUser {UserAccount}
   * @param newUser.email {string}
   * @param newUser.webId {string}
   * @param newUser.name {string}
   *
   * @return {Promise}
   */
  sendWelcomeEmail (newUser) {
    let emailService = this.emailService

    if (!emailService || !newUser.email) {
      return Promise.resolve(null)
    }

    let emailData = {
      to: newUser.email,
      webid: newUser.webId,
      name: newUser.displayName
    }

    return emailService.sendWithTemplate('welcome', emailData)
  }
}

module.exports = AccountManager
