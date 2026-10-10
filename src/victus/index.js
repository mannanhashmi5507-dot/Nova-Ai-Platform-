'use strict';

module.exports = {
  ...require('./core'),
  evolution: {
    ...require('./evolution/registry'),
    ...require('./evolution/controller'),
  },
  core: require('./core'),
  VictusEngine: require('./core/engine').VictusEngine,
  ...require('./core/engine'),
  world: require('./world/model'),
  ...require('./world/model'),
  mission: require('./mission/engine'),
  ...require('./mission/engine'),
  internet: require('./internet/gateway'),
  ...require('./internet/gateway'),
};
