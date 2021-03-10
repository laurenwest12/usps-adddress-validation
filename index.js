const express = require('express');
const app = express();
const USPS = require('usps-webtools');
const sql = require('msnodesqlv8')

const { username, server, database, driver } = require('./config');

const connectionString = `server=${server};Database=${database};Trusted_Connection=Yes;Driver=${driver}`

const insertFields = `("SoldTo","invoiceNumber","originalAddress1","originalAddress2","originalCity","originalState","originalZip","updatedAddress1","updatedAddress2","updatedCity","updatedState","updatedZip","status")`

/* Statement to get all data from SQL Server. */
const selectStatement = `SELECT TOP 10 * FROM GlipsumAPISummary`

/* Statement to insert values into a SQL Server table. */
const insertStatement = (table, fields, values) => {
    return `INSERT INTO ${table} ${fields} VALUES ${values}`
}

/* 
Generte the VALUES() format to later be inserted into SQL Server. 
Input: [originalAddress, updatedAddress]
    originalAddress = {
        soldTo: '',
        invoiceNumber: '',
        address1: '',
        address2: '',
        city: '',
        state: '',
        zip: ''
    }
    updatedAddress = {
        address1: '',
        address2: '',
        city: '',
        state: '',
        zip: '',
        status: ''
    }
*/

const generateQueryRow = (arr) => {
    let valueStr = `(`
    const original = arr[0]
    const updated = arr[1]

    const newObj = {
        soldTo: original.soldTo,
        InvoiceNumber: original.invoiceNumber,
        originalAddress1: original.address1,
        originalAddress2: original.address2,
        originalCity: original.city,
        originalState: original.state,
        originalZip: original.zip,
        updatedAddress1: updated.address1,
        updatedAddress2: updated.address2,
        updatedCity: updated.city,
        updatedState: updated.state,
        updatedZip: updated.zip,
        status: updated.status
    }

    let values = Object.values(newObj)
    
    values.map((value, index) => {
        if (typeof value === 'string') {
            value = value.replace(/'/g, "''")
        }

        if (index !== values.length - 1) {
            valueStr += `'${value}',`
        } else {
            valueStr += `'${value}')`
        }
    })

    return valueStr
}

const insertQuery = async (table, fields, values) => {
    const row = generateQueryRow(values)
    const query = insertStatement(table, fields, row)
    await sql.query(connectionString, query, (err) => {
        if (err) console.log(err)
    })
    return query
}

/* Establish connection to USPS API. */
const usps = new USPS({
    server: 'http://production.shippingapis.com/ShippingAPI.dll',
    userId: username,
    ttl: 10000 
})

/* Create a function that will check if the original address matches the returned address from USPS.
If not, return an array of what is different. */
const returnStatus = (originalAddress, updatedAddress) => {
    let statuses = []
    let statusString = ''

    if (originalAddress.city.toUpperCase() !== updatedAddress.city.toUpperCase()) {
        statuses.push('City')
    }

    if (originalAddress.state.toUpperCase() !== updatedAddress.state.toUpperCase()) {
        statuses.push('State')
    }

    if (originalAddress.zip.substring(0, 5) !== updatedAddress.zip.substring(0,5)) {
        statuses.push('Zip')
    }

    statuses.map((status, index) => {
        length = statuses.length
        if (index === length - 1) {
            statusString += (`${status}`)
        } else if (index < length - 1) {
            statusString += push(`${status}, `)
        }
    })
    return statusString
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
    }, async (err, address) => {
        if (err) {
            //If there is an error with street1, check with street2.
            usps.verify({
                street1: originalAddress2,
                street2: '',
                city: originalCity,
                state: originalState,
                zip: originalZip
            }, async (err, address) => {
                if (err) {
                    const originalAddress = {
                        soldTo: SoldTo,
                        invoiceNumber: InvoiceNumber,
                        address1: originalAddress1,
                        address2: originalAddress2,
                        city: originalCity,
                        state: originalState,
                        zip: originalZip
                    }

                    const updatedAddress = {
                        address1: '',
                        address2: '',
                        city: '',
                        state: '',
                        zip: '',
                        status: `Error: ${err.message}`
                    }

                    const query = await insertQuery('CityStateZipValidation', insertFields, [originalAddress, updatedAddress])
                    console.log(query)
                } else {
                    const originalAddress = {
                        soldTo: SoldTo,
                        invoiceNumber: InvoiceNumber,
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
                        zip: address.zip,
                        status: ''
                    }

                    status = returnStatus(originalAddress, updatedAddress)
                    updatedAddress.status = status

                    if (updatedAddress.status !== '') {
                        const query = await insertQuery('CityStateZipValidation', insertFields, [originalAddress, updatedAddress])
                        console.log(query)
                    }
                }
            })
        } else {
            //Return the result from street1 if it did not error.
            const originalAddress = {
                soldTo: SoldTo,
                invoiceNumber: InvoiceNumber,
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
                zip: address.zip,
                status: ''
            }

            status = returnStatus(originalAddress, updatedAddress)
            updatedAddress.status = status

            console.log(originalZip.substring(0, 5))

            if (updatedAddress.status !== '') {
                const query = await insertQuery('CityStateZipValidation', insertFields, [originalAddress, updatedAddress])
                console.log(query)
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