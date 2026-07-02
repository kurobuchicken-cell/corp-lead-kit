'use strict';

module.exports = {
  collectFromCsv: require('./m1_collect').collectFromCsv,
  enrichSites: require('./m2_enrich').enrichSites,
  filterCompliant: require('./m3_filter').filterCompliant,
  addToSuppression: require('./suppression').addToSuppression,
};
