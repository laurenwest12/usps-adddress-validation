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

const insertFields = `("SoldTo","invoiceNumber","originalAddress1", "originalAddress2", "originalCity","originalState","originalZip","updatedAddress1","updatedAddress2","updatedCity","updatedState","updatedZip","status")`;

/* Statement to get all data from SQL Server. */
const selectStatement = `SELECT * FROM GlipsumAPISummary WHERE CheckedFlag <> 'Y'`;
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

/* Create a function that will check if the original address matches the returned address from USPS.
If not, return an array of what is different. */
const returnStatus = (originalAddress, updatedAddress) => {
	let statuses = [];
	let statusString = '';

	if (
		updatedAddress.address1 &&
		originalAddress.address1.toUpperCase() !==
			updatedAddress.address1.toUpperCase()
	) {
		statuses.push('Address 1');
	}

	if (
		updatedAddress.address2 &&
		originalAddress.address2.toUpperCase() !==
			updatedAddress.address2.toUpperCase()
	) {
		statuses.push('Address 2');
	}

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
		DirecttoStoreAddress1,
		DirecttoStoreAddress2,
		DirecttoStoreCity,
		DirecttoStoreState,
		DirecttoStoreZip,
	} = address;

	const originalAddress1 = DirecttoStoreAddress1.trim();
	const originalAddress2 = DirecttoStoreAddress2.trim();
	const originalCity = DirecttoStoreCity.trim();
	const originalState = DirecttoStoreState.trim();
	const originalZip = DirecttoStoreZip.trim();

	try {
		usps.cityStateLookup(originalZip.substring(0, 5), async (err, res) => {
			const originalAddress = {
				soldTo: SoldTo,
				invoiceNumber: InvoiceNumber,
				address1: originalAddress1,
				address2: originalAddress2,
				city: originalCity,
				state: originalState,
				zip: originalZip,
			};

			const updatedAddressFormat = {
				address1: '',
				address2: '',
				city: '',
				state: '',
				zip: '',
				status: '',
			};

			if (err) {
				//If there is an error, something is wrong with the zipcode so try address validation.
				usps.verify(
					{
						street1: originalAddress1,
						street2: '',
						city: originalCity,
						state: originalState,
						zip: originalZip,
					},
					async (err1, address1) => {
						if (err1) {
							//If there is an error on street1, try to lookup with street2.
							usps.verify(
								{
									street1: originalAddress2,
									street2: '',
									city: originalCity,
									state: originalState,
									zip: originalZip,
								},
								async (err2, address2) => {
									if (err2) {
										const updatedFields = {
											status: `Error: Address validation ${err2.message}`,
										};
										const updatedError2Obj = {
											...updatedAddressFormat,
											...updatedFields,
										};

										// console.log(updatedError2Obj);
										const query = await insertQuery(
											'GlipsumCityStateZipValidation',
											insertFields,
											[originalAddress, updatedError2Obj]
										);
									} else {
										//Found an address2 match
										const {
											street1,
											city,
											state,
											zip,
										} = address2;
										const status = returnStatus(
											originalAddress,
											{
												address1: '',
												address2: street1,
												city,
												state,
												zip,
											}
										);
										const objStatus = `Address 2 Lookup: ${status}`;
										const updatedFields = {
											address1: '',
											address2: street1,
											city,
											state,
											zip,
											status: objStatus,
										};
										const updatedAddress2 = {
											...updatedAddressFormat,
											...updatedFields,
										};

										// console.log(
										// 	originalAddress,
										// 	updatedAddress2
										// );
										const query = await insertQuery(
											'GlipsumCityStateZipValidation',
											insertFields,
											[originalAddress, updatedAddress2]
										);
									}
								}
							);
						} else {
							//Found an address1 match
							const {
								street1,
								street2,
								city,
								state,
								zip,
							} = address1;
							const status = returnStatus(originalAddress, {
								address1: street1,
								address2: street2,
								city,
								state,
								zip,
							});
							const objStatus = `Address 1 Lookup: ${status}`;
							const updatedFields = {
								address1: street1,
								address2: street2,
								city,
								state,
								zip,
								status: objStatus,
							};
							const updatedAddress1 = {
								...updatedAddressFormat,
								...updatedFields,
							};

							// console.log(originalAddress, updatedAddress1);

							const query = await insertQuery(
								'GlipsumCityStateZipValidation',
								insertFields,
								[originalAddress, updatedAddress1]
							);
						}
					}
				);
			} else {
				const { city, state, zip } = res;

				const status = returnStatus(originalAddress, {
					city,
					state,
					zip,
				});

				//Record any changes to the city/state when doing a zipcode lookup.
				if (status !== '' && status.indexOf('State') === -1) {
					const objStatus = `Zipcode lookup: ${status} changed`;

					const updatedFields = {
						city,
						state,
						zip,
						status: objStatus,
					};

					const updatedZipcodeAddress = {
						...updatedAddressFormat,
						...updatedFields,
					};

					const query = await insertQuery(
						'GlipsumCityStateZipValidation',
						insertFields,
						[originalAddress, updatedZipcodeAddress]
					);
				} else if (status.indexOf('State') !== -1) {
					//If the state has changed, it is most likely that the zipcode is wrong.
					//Do an address lookup on these entries.
					usps.verify(
						{
							street1: originalAddress1,
							street2: '',
							city: originalCity,
							state: originalState,
							zip: originalZip,
						},
						async (err1, address1) => {
							if (err1) {
								//If there is an error on street1, try to lookup with street2.
								usps.verify(
									{
										street1: originalAddress2,
										street2: '',
										city: originalCity,
										state: originalState,
										zip: originalZip,
									},
									async (err2, address2) => {
										if (err2) {
											const updatedFields = {
												status: `Error: Address validation ${err2.message}`,
											};
											const updatedError2Obj = {
												...updatedAddressFormat,
												...updatedFields,
											};

											// console.log(updatedError2Obj);
											const query = await insertQuery(
												'GlipsumCityStateZipValidation',
												insertFields,
												[
													originalAddress,
													updatedError2Obj,
												]
											);
										} else {
											//Found an address2 match
											const {
												street1,
												city,
												state,
												zip,
											} = address2;
											const status = returnStatus(
												originalAddress,
												{
													address1: '',
													address2: street1,
													city,
													state,
													zip,
												}
											);
											const objStatus = `Address 2 Lookup: ${status}`;
											const updatedFields = {
												address1: '',
												address2: street1,
												city,
												state,
												zip,
												status: objStatus,
											};
											const updatedAddress2 = {
												...updatedAddressFormat,
												...updatedFields,
											};

											// console.log(
											// 	originalAddress,
											// 	updatedAddress2
											// );
											const query = await insertQuery(
												'GlipsumCityStateZipValidation',
												insertFields,
												[
													originalAddress,
													updatedAddress2,
												]
											);
										}
									}
								);
							} else {
								//Found an address1 match
								const {
									street1,
									street2,
									city,
									state,
									zip,
								} = address1;
								const status = returnStatus(originalAddress, {
									address1: street1,
									address2: street2,
									city,
									state,
									zip,
								});
								const objStatus = `Address 1 Lookup: ${status}`;
								const updatedFields = {
									address1: street1,
									address2: street2,
									city,
									state,
									zip,
									status: objStatus,
								};
								const updatedAddress1 = {
									...updatedAddressFormat,
									...updatedFields,
								};

								// console.log(originalAddress, updatedAddress1);
								const query = await insertQuery(
									'GlipsumCityStateZipValidation',
									insertFields,
									[originalAddress, updatedAddress1]
								);
							}
						}
					);
				}
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
