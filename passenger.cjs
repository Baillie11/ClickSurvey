// Passenger loads the startup file with require(), rather than as the main module.
require('./app').start().catch(error => {
  console.error('ClickSurvey startup failed:', error.code || error.message);
  process.exitCode = 1;
});
