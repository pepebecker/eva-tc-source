/**
 * Typed Eva: static typecheker.
 *
 * (C) 2022-present Dmitry Soshnikov <dmitry.soshnikov@gmail.com>
 */

const Type = require('./Type');
const TypeEnvironment = require('./TypeEnvironment');

/**
 * Typed Eva: static typecheker.
 */
class EvaTC {
  /**
   * Creates an Eva instance with the global environment.
   */
  constructor() {
    /**
     * Create the Global TypeEnvironment per Eva instance.
     */
    this.global = this._createGlobal();
  }

  /**
   * Evaluates global code wrapping into a block.
   */
  tcGlobal(exp) {
    return this._tcBody(exp, this.global);
  }

  /**
   * Checks body (global or function).
   */
  _tcBody(body, env) {
    if (body[0] === 'begin') {
      return this._tcBlock(body, env);
    }
    return this.tc(body, env);
  }

  /**
   * Infers and validates type of an expression.
   */
  tc(exp, env = this.global) {
    // --------------------------------------------
    // Self-evaluating:

    /**
     * Numbers: 10
     */
    if (this._isNumber(exp)) {
      return Type.number;
    }

    /**
     * Strings: "hellow"
     */
    if (this._isString(exp)) {
      return Type.string;
    }

    // --------------------------------------------
    // Boolean: true | false

    if (this._isBoolean(exp)) {
      return Type.boolean;
    }

    // --------------------------------------------
    // Math operations:

    if (this._isBinary(exp)) {
      return this._binary(exp, env);
    }

    // --------------------------------------------
    // Boolean binary:

    if (this._isBooleanBinary(exp)) {
      return this._booleanBinary(exp, env);
    }

    // --------------------------------------------
    // Type declaration/alias: (type <name> <base>)

    if (exp[0] === 'type') {
      const [_tag, name, base] = exp;

      // Union type: (or number string)

      if (base[0] === 'or') {
        const options = base.slice(1);
        const optionTypes = options.map(option => Type.fromString(option));
        return (Type[name] = new Type.Union({name, optionTypes}));
      }

      // Type alias:

      else {
        if (Type.hasOwnProperty(name)) {
          throw `Type ${name} is already defined: ${Type[name]}.`;
        }

        if (!Type.hasOwnProperty(base)) {
          throw `Type ${base} is not defined.`;
        }

        return (Type[name] = new Type.Alias({
          name,
          parent: Type[base]
        }));
      }
    }

    // --------------------------------------------
    // Class declaration: (class <Name> <Super> <Body>)

    if (exp[0] === 'class') {
      const [_tag, name, superClassName, body] = exp;

      // Resolve super:
      const superClass = Type[superClassName];

      // New class (type):
      const classType = new Type.Class({name, superClass});

      // Class is accessible by name.
      Type[name] = env.define(name, classType);

      // Body is evaluated in the class environment.

      this._tcBody(body, classType.env);

      return classType;
    }

    // --------------------------------------------
    // Class instantiation: (new <Class> <Arguments>...)

    if (exp[0] === 'new') {
      const [_tag, className, ...argValues] = exp;

      const classType = Type[className];

      if (classType == null) {
        throw `Unknown class: ${className}.`;
      }

      const argTypes = argValues.map(arg => this.tc(arg, env));

      return this._checkFunctionCall(
        classType.getField('constructor'),
        [classType, ...argTypes],
        env,
        exp
      )
    }

    // --------------------------------------------
    // Super expressions: (super <ClassName>)

    if (exp[0] === 'super') {
      const [_tag, className] = exp;

      const classType = Type[className];

      if (classType == null) {
        throw `Unknown class: ${className}.`;
      }

      return classType.superClass;
    }

    // --------------------------------------------
    // Property access: (prop <instance> <name>)

    if (exp[0] === 'prop') {
      const [_tag, instance, name] = exp;

      const instanceType = this.tc(instance, env);

      return instanceType.getField(name);
    }

    // --------------------------------------------
    // Variable declaration: (var x 10)
    //
    // With typecheck: (var (x number) "foo") // error

    if (exp[0] === 'var') {
      const [_tag, name, value] = exp;

      // Infer actual type:
      const valueType = this.tc(value, env);

      // With type check:
      if (Array.isArray(name)) {
        const [varName, typeStr] = name;

        const expectedType = Type.fromString(typeStr);

        // Check type:
        this._expect(valueType, expectedType, value, exp);

        return env.define(varName, expectedType);
      }

      // Simple name:
      return env.define(name, valueType);
    }

    // --------------------------------------------
    // Variable access: foo

    if (this._isVariableName(exp)) {
      return env.lookup(exp);
    }

    // --------------------------------------------
    // Variable update: (set x 10)

    if (exp[0] === 'set') {
      const [_, ref, value] = exp;

      // 1. Assignment to a property:

      if (ref[0] === 'prop') {
        const [_tag, instance, name] = ref;
        const instanceType = this.tc(instance, env);

        const valueType = this.tc(value, env);
        const propType = instanceType.getField(name);

        return this._expect(valueType, propType, value, exp);
      }

      // 2. Simple assignment:

      // The type of the new value should match to the
      // previous type when the variable was defined.

      const valueType = this.tc(value, env);
      const varType = this.tc(ref, env);

      return this._expect(valueType, varType, value, exp);
    }

    // --------------------------------------------
    // Block: sequence of expressions

    if (exp[0] === 'begin') {
      const blockEnv = new TypeEnvironment({}, env);
      return this._tcBlock(exp, blockEnv);
    }

    // --------------------------------------------
    // if-expression:
    //
    //    Γ ⊢ e1 : boolean  Γ ⊢ e2 : t  Γ ⊢ e3 : t
    //   ___________________________________________
    //
    //           Γ ⊢ (if e1 e2 e3) : t
    //
    // Both branches should return the same time t.
    //

    if (exp[0] === 'if') {
      const [_tag, condition, consequent, alternative] = exp;

      // Boolean condition:
      const t1 = this.tc(condition, env);
      this._expect(t1, Type.boolean, condition, exp);

      // Initially, environment used to tc consequent part
      // is the same as the main env, however can be updated
      // for the union type with type casting:
      let consequentEnv = env;

      // Check if the condition is a type casting rule.
      // This is used with union types to make a type concrete:
      //
      // (if (== (typeof foo) "string") ...)
      //
      if (this._isTypeCastCondition(condition)) {
        const [name, specificType] = this._getSpecifiedType(condition);

        // Update environment with the concrete type for this name:
        consequentEnv = new TypeEnvironment(
          {[name]: Type.fromString(specificType)},
          env,
        );
      }

      const t2 = this.tc(consequent, consequentEnv);
      const t3 = this.tc(alternative, env);

      // Same types for both branches:
      return this._expect(t3, t2, exp, exp);
    }

    // --------------------------------------------
    // while-expression:

    if (exp[0] === 'while') {
      const [_tag, condition, body] = exp;

      // Boolean condition:
      const t1 = this.tc(condition, env);
      this._expect(t1, Type.boolean, condition, exp);

      return this.tc(body, env);
    }

    // --------------------------------------------
    // Function declaration: (def square ((x number)) -> number (* x x))
    //
    // Syntactic sugar for: (var square (lambda ((x number)) -> number (* x x)))

    if (exp[0] === 'def') {
      // Transpile to a variable declaration:

      const varExp = this._transformDefToVarLambda(exp);

      if (!this._isGenericDefFunction(exp)) {
        const name = exp[1];
        const params = exp[2];
        const returnTypeStr = exp[4];

        // We have to extend environment with the function name *before*
        // evaluating the body -- this is need to support recursive
        // function calls.

        const paramTypes = params.map(([name, typeStr]) =>
          Type.fromString(typeStr),
        );

        // Predefine from the signature:

        env.define(
          name,
          new Type.Function({
            paramTypes,
            returnType: Type.fromString(returnTypeStr),
          })
        );
      }

      // Delegate to lambda:

      return this.tc(varExp, env);
    }

    // --------------------------------------------
    // Lambda function: (lambda ((x number)) -> number (* x x))

    if (exp[0] === 'lambda') {
      // 1. Generic function:
      if (this._isGenericLambdaFunction(exp)) {
        return this._createGenericFunctionType(exp, env);
      }

      // 2. Simple function:
      return this._createSimpleFunctionType(exp, env);
    }

    // --------------------------------------------
    // Function calls.
    //
    // (square 2)

    if (Array.isArray(exp)) {
      const fn = this.tc(exp[0], env);

      // Simple function calls:
      let actualFn = fn;
      let argValues = exp.slice(1);

      // Generic function call:
      if (fn instanceof Type.GenericFunction) {
        // Actual (instantiated) types:
        const actualTypes = this._extractActualCallTypes(exp)

        // Map the generic types to the actual types:
        const genericTypesMap = this._getGenericTypesMap(
          fn.genericTypes,
          actualTypes
        );

        // Bind parameters and return types:
        const [boundParams, boundReturnType] = this._bindFunctionTypes(
          fn.params,
          fn.returnType,
          genericTypesMap,
        );

        // Check function body with the bound  parameter types:
        // This creates an actual function type.
        //
        // Notice: we pass environment as fn.env, i.e. closured environment.
        //
        actualFn = this._tcFunction(
          boundParams,
          boundReturnType,
          fn.body,
          fn.env, // Closure!
        );

        // In generic function calls parameters are passed from index 2:
        argValues = exp.slice(2);
      }

      // Passed arguments:
      const argTypes = argValues.map(arg => this.tc(arg, env));

      return this._checkFunctionCall(actualFn, argTypes, env, exp);
    }

    throw `Unknown type for expression ${exp}.`;
  }

  /**
   * Maps generic parameter types to actual types.
   */
  _getGenericTypesMap(genericTypes, actualType) {
    const boundTypes = new Map();
    for (let i = 0; i < genericTypes.length; i++) {
      boundTypes.set(genericTypes[i], actualType[i]);
    }
    return boundTypes;
  }

  /**
   * Binds generic parameters and return type to actual types.
   */
  _bindFunctionTypes(params, returnType, genericTypesMap) {
    const actualParams = [];

    // 1. Bind parameter types:

    for (let i = 0; i < params.length; i++) {
      const [paramName, paramType] = params[i];

      let actualParamType = paramType;

      // Generic type -> rewrite to actual.
      if (genericTypesMap.has(paramType)) {
        actualParamType = genericTypesMap.get(paramType);
      }

      actualParams.push([paramName, actualParamType]);
    }

    // 2. Bind return type:

    let actualReturnType = returnType;

    if (genericTypesMap.has(returnType)) {
      actualReturnType = genericTypesMap.get(returnType);
    }

    return [actualParams, actualReturnType];
  }

  /**
   * Extracts types for generic parameter types.
   *
   * (combine <string> "hello")
   */
  _extractActualCallTypes(exp) {
    const data = /^<([^>]+)>$/.exec(exp[1]);

    if (data == null) {
      throw `No actual types provided in generic call: ${exp}.`;
    }

    return data[1].split(',');
  }

  /**
   * Simple function declarations (no generic parameters).
   *
   * Such functions are type-checked during declaration time.
   */
  _createSimpleFunctionType(exp, env) {
    const [_tag, params, _retDel, returnTypeStr, body] = exp;
    return this._tcFunction(params, returnTypeStr, body, env);
  }

  /**
   * Generic function declarations.
   *
   * Such functions are *not* checked at declaration,
   * instead they are checked at call time, when all
   * generic parameters are bound.
   */
  _createGenericFunctionType(exp, env) {
    const [_tag, genericTypes, params, _retDel, returnType, body] = exp;

    return new Type.GenericFunction({
      genericTypesStr: genericTypes.slice(1, -1),
      params,
      body,
      returnType,
      env, // Closure!
    });
  }

  /**
   * Whether the function is generic.
   *
   * (lambda <K> ((x K)) -> K (+ x x))
   */
  _isGenericLambdaFunction(exp) {
    return exp.length === 6 && /^<[^>]+>$/.test(exp[1]);
  }

  /**
   * Whether the function is generic.
   *
   * (def foo <K> ((x K)) -> K (+ x x))
   */
  _isGenericDefFunction(exp) {
    return exp.length === 7 && /^<[^>]+>$/.test(exp[2]);
  }

  /**
   * Transforms def to var-lambda.
   */
  _transformDefToVarLambda(exp) {

    // 1. Generic function:

    if (this._isGenericDefFunction(exp)) {
      const [_tag, name, genericTypesStr, params, _retDel, returnTypeStr, body] = exp;

      return ['var', name, ['lambda', genericTypesStr, params, _retDel, returnTypeStr, body]];
    }

    // 2. Simple function:

    const [_tag, name, params, _retDel, returnTypeStr, body] = exp;

    return ['var', name, ['lambda', params, _retDel, returnTypeStr, body]];
  }

  /**
   * Whether the if-condition is type casting/specification.
   *
   * This is used with union types to make a type concrete:
   *
   * (if (== (typeof foo) "string") ...)
   *
   */
  _isTypeCastCondition(condition) {
    const [op, lhs] = condition;
    return op === '==' && lhs[0] === 'typeof';
  }

  /**
   * Returns specific type after casting.
   *
   * This is used with union types to make a type concrete:
   *
   * (if (== (typeof foo) "string") ...)
   *
   */
  _getSpecifiedType(condition) {
    const [_op, [_typeof, name], specificType] = condition;

    // Return name and the new type (stripping quotes).
    return [name, specificType.slice(1, -1)];
  }

  /**
   * Checks function call.
   */
  _checkFunctionCall(fn, argTypes, env, exp) {
    // Check arity:
    if (fn.paramTypes.length !== argTypes.length) {
      throw `\nFunction ${epx[0]} ${fn.getName()} expects ${
        fn.paramTypes.length
      } arguments, ${argTypes.length} given in ${exp}.\n`;
    }

    // Check if argument types match the parameter types:
    argTypes.forEach((argType, index) => {
      if (fn.paramTypes[index] === Type.any) {
        return;
      }
      this._expect(argType, fn.paramTypes[index], argTypes[index], exp);
    });

    return fn.returnType;
  }

  /**
   * Checks function body.
   */
  _tcFunction(params, returnTypeStr, body, env) {
    const returnType = Type.fromString(returnTypeStr);

    // Parameters environment and types:
    const paramsRecord = {};
    const paramTypes = [];

    params.forEach(([name, typeStr]) => {
      const paramType = Type.fromString(typeStr);
      paramsRecord[name] = paramType;
      paramTypes.push(paramType);
    });

    const fnEnv = new TypeEnvironment(paramsRecord, env);

    // Check the body in the extended environment:
    const actualReturnType = this._tcBody(body, fnEnv);

    // Check return type:
    if (!returnType.equals(actualReturnType)) {
      throw `\nExpected function ${body} to return ${returnType}, but got ${actualReturnType}.\n`;
    }

    // Function type records its parameters and return type,
    // so we can use them to validate function calls:
    return new Type.Function({
      paramTypes,
      returnType,
    });
  }

  /**
   * Checks a block.
   */
  _tcBlock(block, env) {
    let result;

    const [_tag, ...expressions] = block;

    expressions.forEach(exp => {
      result = this.tc(exp, env);
    });

    return result;
  }

  /**
   * Whether the expression is a variable name.
   */
  _isVariableName(exp) {
    return typeof exp === 'string' && /^[+\-*/<>=a-zA-Z0-9_:]+$/.test(exp);
  }

  /**
   * Creates a Global TypeEnvironment.
   */
  _createGlobal() {
    return new TypeEnvironment({
      VERSION: Type.string,

      sum: Type.fromString('Fn<number<number,number>>'),
      square: Type.fromString('Fn<number<number>>'),

      typeof: Type.fromString('Fn<string<any>>'),
    });
  }

  /**
   * Whether the expression is boolean binary.
   */
  _isBooleanBinary(exp) {
    return (
      exp[0] === '==' ||
      exp[0] === '!=' ||
      exp[0] === '>=' ||
      exp[0] === '<=' ||
      exp[0] === '>' ||
      exp[0] === '<'
    );
  }

  /**
   * Boolean binary operators.
   */
  _booleanBinary(exp, env) {
    this._checkArity(exp, 2);

    const t1 = this.tc(exp[1], env);
    const t2 = this.tc(exp[2], env);

    this._expect(t2, t1, exp[2], exp);

    return Type.boolean;
  }

  /**
   * Whether the expression is binary.
   */
  _isBinary(exp) {
    return /^[+\-*/]$/.test(exp[0]);
  }

  /**
   * Binary operators.
   */
  _binary(exp, env) {
    this._checkArity(exp, 2);

    const t1 = this.tc(exp[1], env);
    const t2 = this.tc(exp[2], env);

    const allowedTypes = this._getOperandTypesForOperator(exp[0]);

    this._expectOperatorType(t1, allowedTypes, exp);
    this._expectOperatorType(t2, allowedTypes, exp);

    return this._expect(t2, t1, exp[2], exp);
  }

  /**
   * Returns allowed operand types for an operator.
   */
  _getOperandTypesForOperator(operator) {
    switch (operator) {
      case '+':
        return [Type.string, Type.number];
      case '-':
        return [Type.number];
      case '/':
        return [Type.number];
      case '*':
        return [Type.number];
      default:
        throw `Unknown operator: ${operator}.`;
    }
  }

  /**
   * Throws if operator type doesn't expect the operand.
   */
  _expectOperatorType(type_, allowedTypes, exp) {
    // For union type, _all_ sub-types should support this operation:
    if (type_ instanceof Type.Union) {
      if (type_.includesAll(allowedTypes)) {
        return;
      }
    }

    // Other types:

    else {
      if (allowedTypes.some(t => t.equals(type_))) {
        return;
      }
    }

    throw `\nUnxpected type: ${type_} in ${exp}, allowed: ${allowedTypes}.\n`;
  }

  /**
   * Expects a type.
   */
  _expect(actualType, expectedType, value, exp) {
    if (!actualType.equals(expectedType)) {
      this._throw(actualType, expectedType, value, exp);
    }
    return actualType;
  }

  /**
   * Throws type error.
   */
  _throw(actualType, expectedType, value, exp) {
    throw `\nExpected "${expectedType}" type for ${value} in ${JSON.stringify(exp)}, but got "${actualType}" type.\n`;
  }

  /**
   * Throws for number of arguments.
   */
  _checkArity(exp, arity) {
    if (exp.length - 1 !== arity) {
      throw `\nOperator '${exp[0]}' expects ${arity} operands, ${exp.length -
        1} given in ${exp}.\n`;
    }
  }

  /**
   * Whether the expression is a boolean.
   */
  _isBoolean(exp) {
    return typeof exp === 'boolean' || exp === 'true' || exp === 'false';
  }

  /**
   * Whether the expression is a number.
   */
  _isNumber(exp) {
    return typeof exp === 'number';
  }

  /**
   * Whether the expression is a string.
   */
  _isString(exp) {
    return typeof exp === 'string' && exp[0] === '"' && exp.slice(-1) === '"';
  }
}

module.exports = EvaTC;