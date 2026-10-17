const { createRecordPage } = require('../../utils/record-page');
// Existing shared /schedule?date= links retain their selected day and back path.
Page(createRecordPage(true));
