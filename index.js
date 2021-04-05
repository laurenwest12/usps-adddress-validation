const express = require('express');
const app = express();
const USPS = require('usps-webtools');
const sql = require('msnodesqlv8');
const Bottleneck = require('bottleneck');

const limiter = new Bottleneck({
	minTime: 1,
});

const { username, server, database, driver } = require('./config');
const { response } = require('express');

const connectionString = `server=${server};Database=${database};Trusted_Connection=Yes;Driver=${driver}`;

const insertFields = `("SoldTo","invoiceNumber","originalAddress1", "originalAddress2", "originalCity","originalState","originalZip","updatedAddress1","updatedAddress2","updatedCity","updatedState","updatedZip","status")`;

/* Statement to get all data from SQL Server. */
const selectStatement = `SELECT TOP 100 * FROM GlipsumAPISummary WHERE CheckedFlag <> 'Y'`;
const insertCheckedStatement = `TRUNCATE TABLE GlipsumAPISummaryCheckedLog 
INSERT INTO GlipsumAPISummaryCheckedLog
SELECT InvoiceNumber, SoldTo, DirecttoStoreAddress1, DirecttoStoreAddress2, DirecttoStoreCity, DirecttoStoreState, DirecttoStoreZip, 'Y' as CheckedFlag
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

const updatedAddressFormat = {
	address1: '',
	address2: '',
	city: '',
	state: '',
	zip: '',
	status: '',
};

/* Create a function that will check if the original address matches the returned address from USPS.
If not, return an array of what is different. */
const returnStatus = (originalAddress, updatedAddress) => {
	let statuses = [];
	let statusString = ``;

	if (
		updatedAddress.address1 &&
		originalAddress.originalAddress1.toUpperCase() !==
			updatedAddress.address1.toUpperCase()
	) {
		statuses.push('Address 1');
	}

	if (
		updatedAddress.address2 &&
		originalAddress.originalAddress2.toUpperCase() !==
			updatedAddress.address2.toUpperCase()
	) {
		statuses.push('Address 2');
	}

	if (
		originalAddress.originalCity.toUpperCase() !==
		updatedAddress.city.toUpperCase()
	) {
		statuses.push('City');
	}

	if (
		originalAddress.originalState.toUpperCase() !==
		updatedAddress.state.toUpperCase()
	) {
		statuses.push('State');
	}

	if (
		originalAddress.originalZip.substring(0, 5) !==
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

const getOriginalAddress = (address) => {
	const {
		InvoiceNumber,
		SoldTo,
		DirecttoStoreAddress1,
		DirecttoStoreAddress2,
		DirecttoStoreCity,
		DirecttoStoreState,
		DirecttoStoreZip,
	} = address;

	return {
		originalAddress1: DirecttoStoreAddress1.trim(),
		originalAddress2: DirecttoStoreAddress2.trim(),
		originalCity: DirecttoStoreCity.trim(),
		originalState: DirecttoStoreState.trim(),
		originalZip: DirecttoStoreZip.trim(),
	};
};

const getUpdatedAddress = (address) => {
	const { street1 = '', street2 = '', city, state, zip, status } = address;
	return {
		updatedAddress1: street1,
		updatedAddress2: street2,
		updatedCity: city,
		updatedState: state,
		updatedZip: zip,
		status,
	};
};

const address2Lookup = (address) => {
	return new Promise((resolve) => {
		usps.verify(
			{
				street1: address.originalAddress2,
			},
			(err, updatedAddress) => {
				if (err) {
					updatedAddress.status = `Error: ${err.message}`;
					resolve([adddress, updatedAddress]);
				} else {
					updatedAddress.street2 = updatedAddress.street1;
					updatedAddress.street1 = '';
					const status = returnStatus(address, updatedAddress);
					updatedAddress.status = status
						? 'Address 2 lookup: ' + status
						: status;
					const updated = getUpdatedAddress(updatedAddress);
					resolve([address, updated]);
				}
			}
		);
	});
};

const address1LookUp = (address) => {
	return new Promise((resolve) => {
		usps.verify(
			{
				street1: address.originalAddress1,
				street2: '',
				city: address.originalCity,
				state: address.originalState,
				zip: address.originalZip,
			},
			async (err, updatedAddress) => {
				if (err) {
					const result = await address2Lookup(address);
					resolve(result);
				} else {
					const status = returnStatus(address, updatedAddress);
					updatedAddress.status = status
						? 'Address 1 lookup: ' + status
						: status;
					const updated = getUpdatedAddress(updatedAddress);
					resolve([address, updated]);
				}
			}
		);
	});
};

const zipcodeLookup = (address) => {
	return new Promise((resolve) => {
		usps.cityStateLookup(
			address.originalZip,
			async (err, updatedAddress) => {
				if (err) {
					const result = await address1LookUp(address);
					resolve(result);
				} else {
					const status = returnStatus(address, updatedAddress);
					if (status.indexOf('State') === -1) {
						updatedAddress.status = status
							? 'Zipcode lookup: ' + status
							: status;
						const updated = getUpdatedAddress(updatedAddress);
						resolve([address, updated]);
					} else {
						const result = await address1LookUp(address);
						resolve(result);
					}
				}
			}
		);
	});
};

const addressVerification = async (row) => {
	//First do a zipcode look up. If there is an error or if the state changes, do a address look up.
	const originalAddress = getOriginalAddress(row);
	const zipResult = await zipcodeLookup(originalAddress);
	console.log(zipResult);
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
