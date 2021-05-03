const express = require('express');
const app = express();
const USPS = require('usps-webtools');
const sql = require('msnodesqlv8');
const Bottleneck = require('bottleneck');

const limiter = new Bottleneck({
	minTime: 0.5,
});

const { username, server, database, driver } = require('./config');
const connectionString = `server=${server};Database=${database};Trusted_Connection=Yes;Driver=${driver}`;

/* Establish connection to USPS API. */
const usps = new USPS({
	server: 'https://production.shippingapis.com/ShippingAPI.dll',
	userId: username,
	ttl: 10000,
});

/* Fields that are in the final SQL Server import table.*/
const insertFields = `("originalAddress1", "originalAddress2", "originalCity","originalState","originalZip","updatedAddress1","updatedAddress2","updatedCity","updatedState","updatedZip","status")`;

/* Statement to get all data from SQL Server and later import. */
const selectStatement = `SELECT * FROM GlipsumAPISummary WHERE CheckedFlag <> 'Y'`;
const insertCheckedStatement = `INSERT INTO GlipsumAPISummaryCheckedLog
SELECT DISTINCT DirecttoStoreAddress1
	  ,DirecttoStoreAddress2
	  ,DirecttoStoreCity
	  ,DirecttoStoreState
	  ,DirecttoStoreZip
	  ,'Y'
FROM GlipsumAPISummary WHERE NOT EXISTS 
(SELECT DirecttoStoreAddress1
	  ,DirecttoStoreAddress2
	  ,DirecttoStoreCity
	  ,DirecttoStoreState
	  ,DirecttoStoreZip
FROM GlipsumAPISummaryCheckedLog)`;

/* Statement to insert values into a SQL Server table. */
const insertStatement = (table, fields, values) => {
	return `INSERT INTO ${table} ${fields} VALUES ${values}`;
};

/* Function that actually inserts the values into the SQL Server table.*/
const insertChecked = async () => {
	await sql.query(connectionString, insertCheckedStatement, (err) => {
		if (err) console.log(err);
	});
};

/* 
Generte the VALUES() format to later be inserted into SQL Server. 
Input: [originalAddress, updatedAddress]
    originalAddress = {
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
		originalAddress1: original.originalAddress1,
		originalAddress2: original.originalAddress2,
		originalCity: original.originalCity,
		originalState: original.originalState,
		originalZip: original.originalZip,
		updatedAddress1: updated.updatedAddress1,
		updatedAddress2: updated.updatedAddress2,
		updatedCity: updated.updatedCity,
		updatedState: updated.updatedState,
		updatedZip: updated.updatedZip,
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

/* Query that takes the value and fields, converts them into SQL format, and inserts them into the SQL Server destination table.*/
const insertQuery = async (table, fields, values) => {
	const row = generateQueryRow(values);
	const query = insertStatement(table, fields, row);
	await sql.query(connectionString, query, (err) => {
		if (err) console.log(err);
	});
	return query;
};

/* Create a function that will check if the original address matches the returned address from USPS.
Return an array of what is different in string format. */
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

/*Create a more readable formatted object based on what is returned from the SQL table select statement.*/
const getOriginalAddress = (address) => {
	const {
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

/*Create an object for the updated address that has fields identifying it as the updated address.*/
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

/* Function that uses the USPS API to look up address validation based on the address2 information provided from the SQL table.*/
const address2Lookup = (address) => {
	return new Promise((resolve) => {
		usps.verify(
			{
				street1: address.originalAddress2,
				street2: '',
				city: address.originalCity,
				state: address.originalState,
				zip: address.originalZip,
			},
			async (err, updatedAddress) => {
				//If there is an error, enter it into the table tracking changes with the error.
				if (err) {
					updated = { status: `Error: ${err.message}` };

					await insertQuery(
						'GlipsumAddressValidation',
						insertFields,
						[address, updated]
					);

					resolve([address, updated]);
				} else {
					updatedAddress.street2 = updatedAddress.street1;
					updatedAddress.street1 = '';

					const status = returnStatus(address, updatedAddress);
					updatedAddress.status = status
						? 'Address 2 lookup: ' + status
						: status;
					const updated = getUpdatedAddress(updatedAddress);

					//If there is a change (the status string is not empty), record the changes in the table tracking updates to the address.
					if (status !== '') {
						const query = await insertQuery(
							'GlipsumAddressValidation',
							insertFields,
							[address, updated]
						);
						resolve([address, updated]);
					} else {
						resolve('No changes');
					}
				}
			}
		);
	});
};

/* Function that uses the USPS API to look up address validation based on the address1 information provided from the SQL table.*/
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
				//If there is an error with the address1 lookup, try the address 2 information.
				if (err) {
					const result = await address2Lookup(address);
					resolve(result);
				} else {
					const status = returnStatus(address, updatedAddress);
					updatedAddress.status = status
						? 'Address 1 lookup: ' + status
						: status;
					const updated = getUpdatedAddress(updatedAddress);

					//If something changed (the status string is not empty), then add it to the table tracking changes.
					if (status !== '') {
						const query = await insertQuery(
							'GlipsumAddressValidation',
							insertFields,
							[address, updated]
						);
						resolve([address, updated]);
					} else {
						resolve('No changes');
					}
				}
			}
		);
	});
};

/* Function that uses the USPS API to look up address validation base don the zipcode provided from the SQL table.*/
const zipcodeLookup = (address) => {
	return new Promise((resolve) => {
		usps.cityStateLookup(
			address.originalZip,
			async (err, updatedAddress) => {
				//If there is an error, there is a problem with the zipcode. Try looking the record up by address.
				if (err) {
					const result = await address1LookUp(address);
					resolve(result);
				} else {
					const status = returnStatus(address, updatedAddress);
					if (status === '') {
						resolve('No changes');
					} else if (status.indexOf('State') === -1) {
						//Makes sure the state didn't change and if it did not and there are changes, record these in the table tracking updates.
						updatedAddress.status = status
							? 'Zipcode lookup: ' + status
							: status;
						const updated = getUpdatedAddress(updatedAddress);

						const query = await insertQuery(
							'GlipsumAddressValidation',
							insertFields,
							[address, updated]
						);
						resolve([address, updated]);
					} else {
						//If the state did change, then the zipcode was likely entered wrong. Try to look up the address by address1.
						const result = await address1LookUp(address);
						resolve(result);
					}
				}
			}
		);
	});
};

/* Function that ties together the address validation.*/
const addressVerification = async (row) => {
	const originalAddress = getOriginalAddress(row);
	const zipResult = await zipcodeLookup(originalAddress);
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

		//Insert all rows that were checked.
		await insertChecked();

		//Log that the program is done importing.
		await wait(5000, 'Done');
	});
};

app.listen(5000, async () => {
	console.log('App is running...');
	await selectQuery(selectStatement);
});
