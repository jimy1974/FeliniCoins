const { DataTypes } = require('sequelize');
const sequelize = require('../db'); // Import your `sequelize` instance

const FeliniUser = sequelize.define('FeliniUser', {
  username: {
    type: DataTypes.STRING,
    allowNull: false
  },
  email: {
    type: DataTypes.STRING,
    allowNull: false,
    unique: true
  },
  password: {
    type: DataTypes.STRING,
    allowNull: true
  },
  createdAt: {
    type: DataTypes.DATE,
    allowNull: false,
    defaultValue: sequelize.literal('CURRENT_TIMESTAMP')
  },
  updatedAt: {
    type: DataTypes.DATE,
    allowNull: false,
    defaultValue: sequelize.literal('CURRENT_TIMESTAMP')
  },
  googleId: {
    type: DataTypes.STRING,
    unique: true,
    allowNull: true
  },
  tokens: {
    type: DataTypes.INTEGER,
    defaultValue: 200
  },
  photo: {
    type: DataTypes.STRING,
    allowNull: true
  }
});

module.exports = FeliniUser;
