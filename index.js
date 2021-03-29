const express = require('express');
const app = express();
const USPS = require('usps-webtools');
const sql = require('msnodesqlv8');
const Bottleneck = require('bottleneck');

const limiter = new Bottleneck({
	minTime: 1,
});

const { username, server, database, driver } = require('./config');

const connectionString = `server=${server};Database=${database};Trusted_Connection=Yes;Driver=${driver}`;

const insertFields = `("SoldTo","invoiceNumber","originalCity","originalState","originalZip","updatedCity","updatedState","updatedZip","status")`;

/* Statement to get all data from SQL Server. */
const selectStatement = `SELECT * FROM GlipsumAPISummary WHERE CheckedFlag <> 'Y'`;
const insertCheckedStatement = `TRUNCATE TABLE GlipsumAPISummaryCheckedLog 
INSERT INTO GlipsumAPISummaryCheckedLog
SELECT InvoiceNumber, SoldTo, DirecttoStoreCity, DirecttoStoreState, DirecttoStoreZip, 'Y' as CheckedFlag
FROM GlipsumAPISummary`;

/* Statement to insert values into a SQL Server table. */
const insertStatement = (table, fields, values) => {
	return `INSERT INTO ${table} ${fields} VALUES ${values}`;
};

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
	let valueStr = `(`;
	const original = arr[0];
	const updated = arr[1];

	const newObj = {
		soldTo: original.soldTo,
		InvoiceNumber: original.invoiceNumber,
		originalCity: original.city,
		originalState: original.state,
		originalZip: original.zip,
		updatedCity: updated.city,
		updatedState: updated.state,
		updatedZip: updated.zip,
		status: updated.status,
	};

	let values = Object.values(newObj);

	values.map((value, index) => {
		if (typeof value === 'string') {
			value = value.replace(/'/g, "''");
		}

		if (index !== values.length - 1) {
			valueStr += `'${value}',`;
		} else {
			valueStr += `'${value}')`;
		}
	});

	return valueStr;
};

const insertQuery = async (table, fields, values) => {
	const row = generateQueryRow(values);
	const query = insertStatement(table, fields, row);
	await sql.query(connectionString, query, (err) => {
		if (err) console.log(err);
	});
	return query;
};

/* Establish connection to USPS API. */
const usps = new USPS({
	server: 'http://production.shippingapis.com/ShippingAPI.dll',
	userId: username,
	ttl: 10000,
});

/* Create a function that will check if the original address matches the returned address from USPS.
If not, return an array of what is different. */
const returnStatus = (originalAddress, updatedAddress) => {
	let statuses = [];
	let statusString = '';

	if (
		originalAddress.city.toUpperCase() !== updatedAddress.city.toUpperCase()
	) {
		statuses.push('City');
	}

	if (
		originalAddress.state.toUpperCase() !==
		updatedAddress.state.toUpperCase()
	) {
		statuses.push('State');
	}

	if (
		originalAddress.zip.substring(0, 5) !==
		updatedAddress.zip.substring(0, 5)
	) {
		statuses.push('Zip');
	}

	statuses.map((status, index) => {
		length = statuses.length;
		if (index === length - 1) {
			statusString += `${status}`;
		} else if (index < length - 1) {
			statusString += `${status}, `;
		}
	});

	return statusString;
};

const addressVerification = async (address) => {
	const {
		InvoiceNumber,
		SoldTo,
		DirecttoStoreCity,
		DirecttoStoreState,
		DirecttoStoreZip,
	} = address;

	const originalCity = DirecttoStoreCity.trim();
	const originalState = DirecttoStoreState.trim();
	const originalZip = DirecttoStoreZip.trim();

	try {
		usps.cityStateLookup(originalZip.substring(0, 5), async (err, res) => {
			const originalAddress = {
				soldTo: SoldTo,
				invoiceNumber: InvoiceNumber,
				city: originalCity,
				state: originalState,
				zip: originalZip,
			};

			const updatedAddress = {
				city: '',
				state: '',
				zip: '',
				status: '',
			};

			if (err) {
				updatedAddress.status = `Error: ${err.message}`;
			} else {
				updatedAddress.city = res.city;
				updatedAddress.state = res.state;
				updatedAddress.zip = res.zip;

				const status = returnStatus(originalAddress, updatedAddress);

				//Record any changes to the city/state when doing a zipcode lookup.
				if (status !== '') {
					updatedAddress.status = `Zipcode lookup: ${status} changed`;
				}
			}

			if (updatedAddress.status !== '') {
				const query = await insertQuery(
					'GlipsumCityStateZipValidation',
					insertFields,
					[originalAddress, updatedAddress]
				);
			}
		});
	} catch (err) {
		console.log(err);
	}
};

const wait = (ms, message) => {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	}).then(() => {
		console.log(message);
	});
};

const selectQuery = async (query) => {
	sql.query(connectionString, query, async (err, rows) => {
		if (err) console.log(err);

		//For each row in the table, verify the address.
		for (let row of rows) {
			await limiter.schedule(async () => {
				await addressVerification(row);
			});
		}

		await insertChecked();
		await wait(5000, 'Done');
	});
};

const insertChecked = async () => {
	await sql.query(connectionString, insertCheckedStatement, (err) => {
		if (err) console.log(err);
	});
};

app.listen(5000, async () => {
	console.log('App is running...');
	await selectQuery(selectStatement);
	// await insertChecked();
	// await wait(5000, 'Done');
});
