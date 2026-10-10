'use strict';

class SafetyError extends Error {
  constructor(message, code, status) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.status = status;
  }
}
class KillSwitchEngagedError extends SafetyError { constructor(scope) { super(`Victus ${scope} is stopped by the kill switch`, 'KILL_SWITCH_ENGAGED', 503); } }
class PolicyViolationError extends SafetyError { constructor(message) { super(message, 'POLICY_VIOLATION', 403); } }
class ValidationError extends SafetyError { constructor(message) { super(message, 'INVALID_INPUT', 400); } }
class NotFoundError extends SafetyError { constructor(message) { super(message, 'NOT_FOUND', 404); } }
class StateError extends SafetyError { constructor(message) { super(message, 'INVALID_STATE', 409); } }

module.exports = { SafetyError, KillSwitchEngagedError, PolicyViolationError, ValidationError, NotFoundError, StateError };
