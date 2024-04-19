/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  setupFiles: ['dotenv/config'],
  testPathIgnorePatterns: ['<rootDir>/dist'],
  moduleNameMapper: {
    '^#app/(.*)$': '<rootDir>/src/$1',
  },
};
