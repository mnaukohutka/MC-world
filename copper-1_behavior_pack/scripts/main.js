/*
 * Static imports are the only module mechanism the Bedrock script engine
 * offers, so every module listed here is evaluated before the first line of this
 * file runs. That makes module-scope code matter: a native call made while a
 * module is still being evaluated (early execution) throws and aborts this
 * entry point, and with it every later import. Module scope stays declarative
 * for that reason.
 */
import "./dimension/main_dimension";
import "./block_trigger";
import "./fluid_interactions";
