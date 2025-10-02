var _ = require('lodash'),
xml = require('xmlbuilder'),
moment = require('moment'),
JunitFullReporter;

// JUnit Reporter based on XSD specified by Publish Test Results task for Azure Pipeline / TFS 2018 / TFS 2017 and TFS 2015
// Source: https://docs.microsoft.com/en-us/azure/devops/pipelines/tasks/test/publish-test-results?view=vsts&tabs=yaml
// XSD: https://github.com/windyroad/JUnit-Schema/blob/master/JUnit.xsd

const SEPARATOR = '->';
const REQ_NAME_KEY = '__name__'

/**
 * Resolves the parent qualified name for the provided item
 *
 * @param {PostmanItem|PostmanItemGroup} item The item for which to resolve the full name
 * @param {?String} [separator=SEP] The separator symbol to join path name entries with
 * @returns {String} The full name of the provided item, including prepended parent item names
 * @private
 */
function getParentName (item, separator) {
    if (_.isEmpty(item) || !_.isFunction(item.parent) || !_.isFunction(item.forEachParent)) { 
		return; 
	}

    var chain = [];
	
    item.forEachParent(function (parent) { 
		chain.unshift(parent.name || parent.id); 
	});
	
    return chain.join(_.isString(separator) ? separator : SEPARATOR);
}

/**
 * Recursively search for an item by id within a Postman collection tree.
 * @param {*} node Current node (collection, item group, or item)
 * @param {String} id Item id to find
 * @returns {*} The matched item or undefined
 */
function findItemById (node, id) {
	if (!node) { return; }
	if (node.id === id) { return node; }
	var children = node.item || _.get(node, 'items.members', []) || [];
	for (var i = 0; i < children.length; i++) {
		var found = findItemById(children[i], id);
		if (found) { return found; }
	}
}

/**
 * Safely get script exec lines from a Postman SDK/Event JSON object.
 * @param {*} eventObj Event object (JSON or SDK Event)
 * @returns {Array<string>} lines
 */
function getEventExecLines (eventObj) {
	var script = _.get(eventObj, 'script');
	if (!script) { return []; }
	var exec = _.get(script, 'exec');
	if (!exec && _.isFunction(script.toJSON)) {
		try {
			var json = script.toJSON();
			exec = _.get(json, 'exec');
		} catch (e) {}
	}
	if (typeof exec === 'string') { return [exec]; }
	if (Array.isArray(exec)) { return exec; }
	return [];
}

/**
 * Appends a properties element to the provided testcase with a dynamic test_key.
 * Tries to match ticket per pm.test block name when available.
 * Falls back to any ticket in scripts, then from execution.item.name.
 * Guarantees a non-empty value (defaults to 'UNKNOWN').
 * @param {*} testcase XMLBuilder element representing a testcase
 * @param {*} execution Newman execution object
 * @param {*} collection Original Postman collection definition (from summary.collection)
 * @param {String} testcaseName Name of the testcase (e.g., assertion name)
 * @param {String} propertyType One of 'assertions', 'testScript', 'prerequestScript'
 */
function appendTestcaseProperties (testcase, execution, collection, testcaseName, propertyType) {
	var properties = testcase.ele('properties');
	var property = properties.ele('property');
	property.att('name', 'test_key');
	
	var dynamicValue = '';
	try {
		var originalItem = findItemById(collection, _.get(execution, 'item.id')) || {};
		var events = _.get(originalItem, 'event', []);
		if ((!Array.isArray(events) || !events.length)) {
			var sdkEvents = _.get(originalItem, 'events.members', []);
			if (Array.isArray(sdkEvents) && sdkEvents.length) {
				events = sdkEvents;
			}
		}
		if ((!Array.isArray(events) || !events.length) && _.get(execution, 'item.event')) {
			// fallback to execution snapshot if present
			events = _.get(execution, 'item.event', []);
		}
		if (Array.isArray(events) && events.length) {
			for (var i = 0; i < events.length; i++) {
				var ev = events[i];
				// only inspect test scripts when mapping assertion names
				if (propertyType === 'assertions' && _.get(ev, 'listen') && _.get(ev, 'listen') !== 'test') { continue; }
				var execLines = getEventExecLines(ev);
				if (Array.isArray(execLines) && execLines.length) {
					var joined = execLines.join('\n');
					// 1) Try to find Xray ticket within the specific pm.test block matching testcaseName
					if (propertyType === 'assertions' && testcaseName) {
						// naive block extraction up to closing '});' following the pm.test with the name
						var escapedName = testcaseName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
						var blockRegex = new RegExp('pm\\.test\\(["\']' + escapedName + '["\']\\s*,\\s*function\\s*\\([^)]*\\)\\s*{([\\s\\S]*?)\\}\\);');
						var blockMatch = joined.match(blockRegex);
						if (blockMatch && blockMatch[1]) {
							var block = blockMatch[1];
							var xrayInBlock = block.match(/Xray["'\s,:-]*([A-Z]+-\d+)/) || block.match(/([A-Z]+-\d+)/);
							if (xrayInBlock && xrayInBlock[1]) {
								dynamicValue = xrayInBlock[1];
								break;
							}
						}
					}
					// 2) Otherwise, any ticket-like pattern in scripts (first match)
					if (!dynamicValue) {
						var xrayMatch = joined.match(/Xray["'\s,:-]*([A-Z]+-\d+)/);
						if (xrayMatch && xrayMatch[1]) {
							dynamicValue = xrayMatch[1];
							break;
						}
						var anyTicketMatch = joined.match(/([A-Z]+-\d+)/);
						if (anyTicketMatch && anyTicketMatch[1]) {
							dynamicValue = anyTicketMatch[1];
							break;
						}
					}
				}
			}
		}
	} catch (e) {}
	
	// 3) Fallback to request name (outside try to avoid being skipped on errors)
	if (!dynamicValue) {
		var name = _.get(execution, 'item.name', '');
		var nameMatch = name && name.match(/[A-Z]+-\d+/);
		dynamicValue = nameMatch ? nameMatch[0] : '';
	}
	
	// 4) Final guard to avoid empty values
	if (!dynamicValue) {
		dynamicValue = 'UNKNOWN';
	}
	
	property.att('value', dynamicValue);
}

/**
 * A function that creates raw XML to be written to Newman JUnit reports.
 *
 * @param {Object} newman - The collection run object, with a event handler setter, used to enable event wise reporting.
 * @param {Object} reporterOptions - A set of JUnit reporter run options.
 * @param {String=} reporterOptions.export - Optional custom path to create the XML report at.
 * @returns {*}
 */
JunitFullReporter = function (newman, reporterOptions, options) {
	
	    
	newman.on('beforeDone', function () {
		
		
		var excludeRequestNames = []
		if (reporterOptions.excludeRequest) {
			excludeRequestNames = reporterOptions.excludeRequest.split(',')
		}
        var executions = _.get(newman, 'summary.run.executions'),
		globalValues = _.get(newman, 'summary.globals.values.members', []),
		environmentValues = _.get(newman, 'summary.environment.values.members', []),
		collection = _.get(newman, 'summary.collection'),
		root;
		
		
		//console.log(newman.summary.run.executions[0])
		var date = moment(new Date()).local().format('YYYY-MM-DDTHH:mm:ss.SSS');

        if (!executions) {
            return;
        }

        root = xml.create('testsuites', { version: '1.0', encoding: 'UTF-8' });
		root.att('name', collection.name);
        root.att('tests', _.get(newman, 'summary.run.stats.tests.total', 'unknown'));

		var failuresTotal = 0, errorsTotal = 0;

		// Process executions (testsuites)
		_.forEach(executions, function (execution) {
			
			// exclude requests as requested by user
			if (excludeRequestNames.includes(execution.item.name)) {
				return
			}
			
			var iterationName = 'Iteration ' + execution.cursor.iteration.toString()
			var testsuite = root.ele('testsuite');
			var failures = 0, errors = 0;
			var propertyValues = _.merge(environmentValues, globalValues);
			var requestName = execution.item.name
			
			// Process properties
			if (propertyValues && propertyValues.length) {
				properties = testsuite.ele('properties');
			
				_.forEach(propertyValues, function (propertyItem) {
					
					// do not log overriden name '__name__' properties
					if (propertyItem.key.toLowerCase().startsWith(REQ_NAME_KEY)) {
						// request name: __name__<id_iteration><request_name>
						if (propertyItem.value != null
							&& propertyItem.value.trim() !== '' 
							&& propertyItem.key.toLowerCase() === REQ_NAME_KEY + execution.cursor.iteration + execution.item.name.toLowerCase()) {
							requestName = propertyItem.value;
							
						// iteration name: __name__<id_iteration>
						} else if (propertyItem.value != null
							&& propertyItem.value.trim() !== '' 
							&& propertyItem.key.toLowerCase() === REQ_NAME_KEY + execution.cursor.iteration) {
							iterationName = propertyItem.value;
						}
						return
					}
					
					if (reporterOptions.hideSensitiveData && 
						(
						propertyItem.key.toLowerCase().includes("user")
						|| propertyItem.key.toLowerCase().includes("token")
						|| propertyItem.key.toLowerCase().includes("password")
						|| propertyItem.key.toLowerCase().includes("pwd")
						|| propertyItem.key.toLowerCase().includes("passwd")
						|| propertyItem.key.toLowerCase().includes("usr")
						)) {
						return
					}					
					var property = properties.ele('property');
					property.att('name', propertyItem.key);
					
					if (propertyItem.value === null) {
						propertyItem.value = "";
					}
					
					property.att('value', propertyItem.value.toString().substring(0, 70));
				});
			}
				
            testsuite.att('id', (execution.cursor.iteration * execution.cursor.length) + execution.cursor.position);
			
			// Hostname
			var protocol = _.get(execution, 'request.url.protocol', 'https') + '://';
			var hostName = _.get(execution, 'request.url.host', ['localhost']);

			testsuite.att('hostname', protocol + hostName.join('.'));
			
			// Package
			var packageName = getParentName(execution.item)
			if (execution.cursor.cycles > 1) {
					if (packageName) {
							testsuite.att('package', iterationName + SEPARATOR + packageName);
					} else {
							testsuite.att('package', iterationName);
					}
			} else {
							testsuite.att('package', getParentName(execution.item));
			}


			
			// Name
			
			testsuite.att('name', requestName);
			
			// Tests
			if (execution.assertions) {
				testsuite.att('tests', execution.assertions.length);
			}
			else {
				testsuite.att('tests', 0);
			}
			
			// Timestamp
			testsuite.att('timestamp', date);
			
			// Time
			testsuite.att('time', (_.get(execution, 'response.responseTime') / 1000 || 0).toFixed(3));
			
			// Timestamp (add time)
			date = moment(date).add(_.get(execution, 'response.responseTime'), 'ms').local().format('YYYY-MM-DDTHH:mm:ss.SSS');
			
			// Process assertions (testcases)
			_.forEach(['prerequestScript', 'assertions', 'testScript'], function (property) {
				_.forEach(execution[property], function (testExecution) {
					var testcase = testsuite.ele('testcase');
					
					// Classname
					var className = [];
					className.push(_.get(testcase.up(), 'attributes.package.value'));
					className.push(_.get(testcase.up(), 'attributes.name.value'));
					testcase.att('classname', className.join(SEPARATOR));
					
					var testcaseName = '';
					if (property === 'assertions') {
						// Name
						testcaseName = testExecution.assertion;
						testcase.att('name', testcaseName);
						
						// Time (testsuite time divided by number of assertions)
						testcase.att('time', (_.get(testcase.up(), 'attributes.time.value') / execution.assertions.length || 0).toFixed(3));
					
					} else {
						// Name
						testcaseName = property === 'testScript' ? 'Tests' : 'Pre-request Script';
						testcase.att('name', testcaseName);
					}
					
					// Append testcase properties as requested
					appendTestcaseProperties(testcase, execution, collection, testcaseName, property);
					
					// Errors / Failures
					var errorItem = testExecution.error;
					if (errorItem) {
						var result;
						if (property !== 'assertions') {
							// Error
							++errors;
							result = testcase.ele('error');
							
							if (errorItem.stacktrace) {
								result.dat(errorItem.stacktrace);
							}
						} else {
							// Failure
							++failures;
							result = testcase.ele('failure');
							result.dat(errorItem.stack);
						}
						
						result.att('type', errorItem.name);
						result.att('message', errorItem.message);
					}
				});
			});
			
			// Failures
			testsuite.att('failures', failures);
			failuresTotal += failures;
			
			// Errors
			testsuite.att('errors', errors);
			errorsTotal += errors;
		});
		
        // Total failures and errors across all test suites
        // Add flag --reporter-xunit-aggregate to trigger
        if (reporterOptions.aggregate) {
            root.att('failures', failuresTotal);
            root.att('errors', errorsTotal);
        }

        newman.exports.push({
            name: 'junit-reporter-full',
            default: 'newman-run-report-full.xml',
            path: reporterOptions.export,
            content: root.end({
                pretty: true,
                indent: '  ',
                newline: '\n',
                allowEmpty: false
            })
        });
    });
};

module.exports = JunitFullReporter;
