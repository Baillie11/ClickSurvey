const crypto = require('crypto');
function trackingKey(inviteToken) {
  return crypto.createHash('sha256').update('email-open:' + inviteToken).digest('hex');
}
const pixel = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
module.exports = { trackingKey, pixel };
