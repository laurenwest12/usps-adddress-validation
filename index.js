const express = require('express');
const app = express();
const USPS = require('usps-webtools');

const { username } = require('./config');

const usps = new USPS({
    server: 'http://production.shippingapis.com/ShippingAPI.dll',
    userId: username,
    ttl: 10000 
})



const addressVerification = () => {
    usps.verify({
        street1: '322 3rd st.',
        street2: 'Apt 2',
        city: 'San Francisco',
        state: 'CA',
        zip: '94107'
    }, async (err, address) => {
        console.log(address)
    })
}


app.listen(5000, async () => {
    console.log('App is running...')
    const add = await addressVerification()
})