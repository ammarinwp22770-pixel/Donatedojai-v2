const express = require('express');
const app = express();
const QRcode = require('qrcode');
const generatePayload = require('promptpay-qr');
const bodyParser = require('body-parser');
const _ = require('lodash');
const cors = require('cors');

app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

const server = app.listen(3000, () => {
  console.log('✅ Server is running on port 3000...');
});

app.post('/generateQR', (req, res) => {
  const amount = parseFloat(_.get(req, ['body', 'amount']));
  const mobileNumber = '0815404297';
  const payload = generatePayload(mobileNumber, { amount });
  const option = {
    color: {
      dark: '#000000',
      light: '#ffffff'
    }
  };

  QRcode.toDataURL(payload, option, (err, url) => {
    if (err) {
      console.log('❌ Generate fail:', err);
      return res.status(400).json({
        RespCode: 400,
        RespMessage: 'Bad: ' + err
      });
    } else {
      console.log('✅ QR Generate success');
      return res.status(200).json({
        RespCode: 200,
        RespMessage: 'Good',
        result: url
      });
    }
  });
});

module.exports = app;
