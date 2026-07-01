'use strict';

// M3（filterCompliant）は未実装。実装され次第ここに追加する。
module.exports = {
  collectFromCsv: require('./m1_collect').collectFromCsv,
  enrichSites: require('./m2_enrich').enrichSites,
};
