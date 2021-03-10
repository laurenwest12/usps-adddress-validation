const express = require('express');
const app = express();
const USPS = require('usps-webtools');

const { username, server, database, driver } = require('./config');

const connectionString = `server=${server};Database=${database};Trusted_Connection=Yes;Driver=${driver}`

const selectStatement = `SELECT TOP 10 * FROM GlipsumAPISummary`

const usps = new USPS({
    server: 'http://production.shippingapis.com/ShippingAPI.dll',
    userId: username,
    ttl: 10000 
})

const addressVerification = () => {
    usps.verify({
        street1: '',
        street2: 'Apt 2',
        city: 'San Francisco',
        state: 'CA',
        zip: '94107'
    }, (err, address) => {
        if (err) {
            //If there is an error with street1, check with street2.
            usps.verify({
                street1: '322 3rd st.',
                street2: 'Apt 2',
                city: 'San Francisco',
                state: 'CA',
                zip: '94107'
            }, (err, address) => {
                console.log(address)
            })
        } else {
            //Return the result from street1 if it did not error.
            console.log(err)
        }
    })
}


app.listen(5000, async () => {
    console.log('App is running...')
    const add = await addressVerification()
})