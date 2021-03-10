const express = require('express');
const app = express();
const USPS = require('usps-webtools');
const sql = require('msnodesqlv8')

const { username, server, database, driver } = require('./config');

const connectionString = `server=${server};Database=${database};Trusted_Connection=Yes;Driver=${driver}`

const selectStatement = `SELECT TOP 10 * FROM GlipsumAPISummary`

const usps = new USPS({
    server: 'http://production.shippingapis.com/ShippingAPI.dll',
    userId: username,
    ttl: 10000 
})

/* Create a function that will check if the original address matches the returned address from USPS.
If not, return an array of what is different. */

const returnStatus = (originalAddress, updatedAddress) => {
    let statuses = []

    if (originalAddress.city.toUpperCase() !== updatedAddress.city.toUpperCase()) {
        status.push('City')
    }

    if (originalAddress.state.toUpperCase() !== updatedAddress.state.toUpperCase()) {
        status.push('State')
    }

    if (originalAddress.zip.toUpperCase() !== updatedAddress.zip.toUpperCase()) {
        status.push('Zip')
    }

    return statuses

}

const addressVerification = (address) => {
    const { InvoiceNumber, SoldTo, DirectToStoreAddress1, DirecttoStoreAddress2, DirecttoStoreCity, DirecttoStoreState, DirecttoStoreZip } = address

    const originalAddress1 = DirectToStoreAddress1.trim()
    const originalAddress2 = DirecttoStoreAddress2.trim()
    const originalCity = DirecttoStoreCity.trim()
    const originalState = DirecttoStoreState.trim()
    const originalZip = DirecttoStoreZip.trim()

    usps.verify({
        street1: originalAddress1,
        street2: '',
        city: originalCity,
        state: originalState,
        zip: originalZip
    }, (err, address) => {
        if (err) {
            //If there is an error with street1, check with street2.
            usps.verify({
                street1: originalAddress2,
                street2: '',
                city: originalCity,
                state: originalState,
                zip: originalZip
            }, (err, address) => {
                if (err) {
                    console.log(err.message)
                } else {
                    const originalAddress = {
                        address1: originalAddress1,
                        address2: originalAddress2,
                        city: originalCity,
                        state: originalState,
                        zip: originalZip
                    }

                    const updatedAddress = {
                        address1: '',
                        address2: address.street1,
                        city: address.city,
                        state: address.state,
                        zip: address.zip
                    }
                }
            })
        } else {
            //Return the result from street1 if it did not error.
            const originalAddress = {
                address1: originalAddress1,
                address2: originalAddress2,
                city: originalCity,
                state: originalState,
                zip: originalZip
            }

            const updatedAddress = {
                address1: address.street1,
                address2: '',
                city: address.city,
                state: address.state,
                zip: address.zip
            }
        }
    })
}

const selectQuery = async (query) => {
    await sql.query(connectionString, query, (err, rows) => {
        if (err) console.log(err)
        //For each row in the table, verify the address.
        rows.map(row => addressVerification(row))
    }) 
}


app.listen(5000, async () => {
    console.log('App is running...')
    await selectQuery(selectStatement)
})