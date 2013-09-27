/**
 * Created with JetBrains PhpStorm.
 * User: francis
 * Date: 9/21/13
 * Time: 8:59 AM
 */

(function () {

  // global on the server, window in the browser
  var root = this;
  var Mingo = {}, previousMingo;
  var _;

  // backup previous Mingo
  if (root != null) {
    previousMingo = root.Mingo;
  }

  Mingo.noConflict = function () {
    root.Mingo = previousMingo;
    return Mingo;
  };

  // Export the Mingo object for **Node.js**
  if (typeof exports !== 'undefined') {
    if (typeof module !== 'undefined' && module.exports) {
      exports = module.exports = Mingo;
    } else {
      exports = Mingo;
    }
    _ = require("underscore"); // get a reference to underscore
  } else {
    root.Mingo = Mingo;
    _ = root._; // get a reference to underscore
  }

  // quick reference for
  var primitives = [
    _.isString, _.isBoolean, _.isNumber, _.isDate, _.isNull, _.isRegExp
  ];

  var normalize = function(value) {
    for (var i = 0; i < primitives.length; i++) {
      if (primitives[i](value)) {
        if (_.isRegExp(value)) {
          return {"$regex": value};
        } else {
          return {"$eq": value};
        }
      }
    }
    if (_.isObject(value)) {
      var notQuery = _.intersection(Ops.queryOperators, _.keys(value)).length === 0;
      if (notQuery) {
        return {"$eq": value};
      }
    }
    return value;
  };

  /**
   * Query object to test collection elements with
   * @param criteria the pass criteria for the query
   * @constructor
   */
  Mingo.Query = function (criteria) {
    this._criteria = criteria;
    this._compiledSelectors = [];
    this._compile();
  };

  Mingo.Query.prototype = {

    _compile: function () {
      if (!_.isEmpty(this._criteria) && _.isObject(this._criteria)) {
        for (var name in this._criteria) {
          var value = this._criteria[name];
          if (_.contains(Ops.compoundOperators, name)) {
            if (_.contains(["$not", "$elemMatch"], name)) {
              throw Error("Invalid operator");
            }
            this._processOperator(name, name, value);
          } else {
            // normalize value
            value = normalize(value);
            for (var operator in value) {
              this._processOperator(name, operator, value[operator]);
            }
          }
        }
      }
    },

    _processOperator: function (field, operator, value) {
      var compiledSelector;
      if (_.contains(Ops.simpleOperators, operator)) {
        compiledSelector = {
          test: function (obj) {
            var actualValue = Mingo._resolve(obj, field);
            // value of operator must already be fully resolved.
            return simpleOperators[operator](actualValue, value);
          }
        };
      } else if (_.contains(Ops.compoundOperators, operator)) {
        compiledSelector = compoundOperators[operator](field, value);
      } else {
        throw Error("Invalid query operator '" + operator + "' detected");
      }
      this._compiledSelectors.push(compiledSelector);
    },

    test: function (model) {
      var match = true;
      for (var i = 0; i < this._compiledSelectors.length; i++) {
        var compiled = this._compiledSelectors[i];
        match = compiled.test(model);
        if (match === false) {
          break;
        }
      }
      return match;
    },

    find: function(collection, projection) {
      return new Mingo.Cursor(collection, this, projection);
    }

  };

  /**
   * Cursor to
   * @param collection
   * @param query
   * @param projection
   * @constructor
   */
  Mingo.Cursor = function (collection, query, projection) {
    this.query = query;
    this.collection = collection;
    this._projection = projection;
    this._operators = {};
    this._result = false;
    this._position = 0;
  };

  Mingo.Cursor.prototype = {

    _fetch: function () {
      var self = this;

      if (this._result === false) {

        // inject projection operator
        if (_.isObject(this._projection)) {
          _.extend(this._operators, {"$project": this._projection});
        }

        // support Backbone Collections if available
        if (root != null && !!root.Backbone && !!root.Backbone.Collection) {
          if (this.collection instanceof root.Backbone.Collection) {
            this.collection = this.collection.models;
          }
        }

        if (!_.isArray(this.collection)) {
          throw Error("Input collection is not of a valid type.")
        }

        // filter collection
        this._result = _.filter(this.collection, this.query.test, this.query);
        var pipeline = [];

        _.each(['$sort', '$skip', '$limit', '$project'], function (op) {
          if (_.has(self._operators, op)) {
            pipeline.push(_.pick(self._operators, op));
          }
        });

        if (pipeline.length > 0) {
          var aggregator = new Mingo.Aggregator(pipeline);
          this._result = aggregator.run(this._result);
        }
      }
      return this._result;
    },

    /**
     * Fetch and return all matched results
     * @returns {Array}
     */
    all: function () {
      return this._fetch();
    },

    /**
     * Fetch and return the first matching result
     * @returns {Object}
     */
    one: function () {
      return _.first(this._fetch(), 1);
    },

    /**
     * Counts the number of matched objects found
     * @returns {Number}
     */
    count: function () {
      return this._fetch().length;
    },

    /**
     * Sets the number of results to skip before returning any results.
     * This is useful for pagination.
     * Default is to skip zero results.
     * @param {Number} n the number of results to skip.
     * @return {Mingo.Cursor} Returns the cursor, so you can chain this call.
     */
    skip: function(n) {
      _.extend(this._operators, {"$skip": n});
      return this;
    },

    /**
     * Sets the limit of the number of results to return.
     * @param {Number} n the number of results to limit to.
     * @return {Mingo.Cursor} Returns the cursor, so you can chain this call.
     */
    limit: function(n) {
      _.extend(this._operators, {"$limit": n});
      return this;
    },

    /**
     * Sets the sort order of the matching objects
     * @param {Object} modifier an object of key fields and the sort order. 1 for ascending and -1 for descending
     * @return {Mingo.Cursor} Returns the cursor, so you can chain this call.
     */
    sort: function (modifier) {
      _.extend(this._operators, {"$sort": modifier});
      return this;
    },

    /**
     * Fetched the next value in the cursor
     * @returns {*}
     */
    next: function () {
      if (this.hasNext()) {
        return this._result[this._position++];
      }
      return false;
    },

    /**
     * Checks if the cursor can continue to iterate
     * @returns {boolean}
     */
    hasNext: function () {
      return this._fetch().length > this._position;
    },

    max: function (expr) {
      return groupOperators.$max(this.all(), expr);
    },

    min: function (expr) {
      return groupOperators.$min(this.all(), expr);
    },

    map: function () {

    }

  };

  Mingo.Aggregator = function (operators) {
    this._operators = operators;
  };

  Mingo.Aggregator.prototype =  {
    run: function (collection) {
      if (!_.isEmpty(this._operators)) {
        // run aggregation pipeline
        for (var i = 0; i < this._operators.length; i++) {
          var operator = this._operators[i];
          for (var key in operator) {
            collection = pipelineOperators[key](collection, operator[key]);
          }
        }
      }
      return collection;
    }
  };

  /**
   * Retrieve the value of a given key on an object
   * @param obj
   * @param field
   * @returns {*}
   * @private
   */
  Mingo._get = function (obj, field) {
    if (root != null && !!root.Backbone && !!root.Backbone.Model) {
      if (obj instanceof root.Backbone.Model) {
        return obj.get(field);
      }
    }
    return _.result(obj, field);
  };

  /**
   * Resolve the value of the field (dot separated) on the given object
   * @param obj
   * @param field
   * @returns {*}
   */
  Mingo._resolve = function (obj, field) {
    if (!field) {
      return undefined;
    }
    var chain = field.split(".");
    var value = obj;
    for (var i = 0; i < chain.length; i++) {
      value = Mingo._get(value, chain[i]);
      if (value === undefined) {
        break;
      }
    }

    return value;
  };

  /**
   * Compiles a criteria to a Query object
   * @param criteria
   * @returns {Mingo.Query}
   */
  Mingo.compile = function (criteria) {
    return new Mingo.Query(criteria);
  };

  /**
   * Return a cursor for the given query criteria and options
   * @param collection
   * @param criteria
   * @param projection
   * @returns {*}
   */
  Mingo.find = function (collection, criteria, projection) {
    return Mingo.compile(criteria).find(collection, projection);
  };

  /**
   * Mixin for Backbone.Collection objects
   * @type {{find: Function}}
   */
  Mingo.CollectionMixin = {
    query: function (criteria, projection) {
      return Mingo.find(this, criteria, projection);
    }
  };

  var pipelineOperators = {

    $group: function (collection, expr) {
      var id = expr["_id"];
      var groups = _.groupBy(collection, function (obj) {
        return computeValue(obj, id, id);
      });

      expr = _.omit(expr, "_id");
      groups = _.pairs(groups);
      var result = [];
      while (groups.length > 0) {
        var tuple = groups.pop();
        var obj = {"_id": tuple[0]};
        for (var key in expr) {
          obj[key] = accumulate(tuple[1], key, expr[key]);
        }
        result.push(obj);
      }

      return result;
    },

    $match: function (collection, expr) {
      var query = new Mingo.Query(expr);
      return query.find(collection).all();
    },

    $project: function (collection, expr) {
      var whitelist = [],
        blacklist = [],
        computedFields = {};

      for (var key in expr) {
        var obj = expr[key];
        if (obj === 1 || obj === true) {
          whitelist.push(key);
        } else if (obj === 0 || obj === false) {
          blacklist.push(key);
        } else if (_.isString(obj) || _.isObject(obj)) {
          computedFields[key] = obj;
        }
      }

      var projected = [];
      var filter = function (obj) { return obj; };

      if (whitelist.length > 0) {
        if (!_.contains(blacklist, "id")) {
          whitelist.push("id");
        }
        filter = function (obj) {
          return _.pick(obj, whitelist);
        };
      } else if (blacklist.length > 0) {
        filter = function (obj) {
          return _.omit(obj, blacklist);
        };
      }

      for (var i=0; i < collection.length; i++) {
        var record = collection[i];
        for (var field in computedFields) {
          record = computeValue(record, computedFields[field], field);
        }
        record = filter(record);
        projected.push(record);
      }

      return projected;
    },

    $limit: function (collection, value) {
      return _.first(collection, value);
    },

    $skip: function (collection, value) {
      _.rest(collection, value);
    },

    $unwind: function (collection, expr) {
      var result = [];
      var field = expr.substr(1);
      _.each(collection, function (obj) {
        // must throw an error if value is not an array
        var value = Mingo._get(obj, field);
        if (!!value && _.isArray(value)) {
          _.each(value, function (item) {
            obj[field] = item;
            result.push(obj);
          });
        }
      });
      return result;
    },

    $sort: function (collection, sortKeys) {
      if (!_.isEmpty(sortKeys) && _.isObject(sortKeys)) {
        var modifiers = _.keys(sortKeys);
        modifiers.reverse().forEach(function (key) {
          var grouped = _.groupBy(collection, function (obj) {
            return Mingo._get(obj, key);
          });
          var indexes = _.keys(grouped);
          var sorted = _.sortBy(indexes, function (obj) {
            return obj;
          });
          if (sortKeys[key] === -1) {
            sorted.reverse();
          }
          collection = [];
          _.each(sorted, function (item) {
            Array.prototype.push.apply(collection, grouped[item]);
          });
        });
      }
      return collection;
    }

  };

  var compoundOperators = {

    /**
     * $and performs a logical AND operation on an array of two or more expressions (e.g. <expression1>, <expression2>, etc.)
     * and selects the documents that satisfy all the expressions in the array. The $and operator uses short-circuit evaluation.
     * If the first expression (e.g. <expression1>) evaluates to false, MongoDB will not evaluate the remaining expressions
     *
     * @param selector
     * @param value
     * @returns {{test: Function}}
     */
    $and: function (selector, value) {
      if (!_.isArray(value)) {
        throw new Error("Invalid expression for $and criteria");
      }
      var queries = [];
      _.each(value, function (expr) {
        queries.push(new Mingo.Query(expr));
      });

      return {
        test: function (obj) {
          for (var i =0; i < queries.length; i++) {
            if (queries[i].test(obj) === false) {
              return false;
            }
          }
          return true;
        }
      };
    },

    /**
     * The $or operator performs a logical OR operation on an array of two or more <expressions> and selects
     * the documents that satisfy at least one of the <expressions>
     *
     * @param selector
     * @param value
     * @returns {{test: Function}}
     */
    $or: function (selector, value) {
      if (!_.isArray(value)) {
        throw new Error("Invalid expression for $or criteria");
      }
      var queries = [];
      _.each(value, function (expr) {
        queries.push(new Mingo.Query(expr));
      });

      return {
        test: function (obj) {
          for (var i = 0; i < queries.length; i++) {
            if (queries[i].test(obj) === true) {
              return true;
            }
          }
          return false;
        }
      };
    },

    /**
     * $nor performs a logical NOR operation on an array of two or more <expressions> and
     * selects the documents that fail all the <expressions> in the array.
     *
     * @param selector
     * @param value
     * @returns {{test: Function}}
     */
    $nor: function (selector, value) {
      if (!_.isArray(value)) {
        throw new Error("Invalid expression for $nor criteria");
      }
      var query = this.$or("$or", value);
      return {
        test: function (obj) {
          return !query.test(obj);
        }
      };
    },

    /**
     * $not performs a logical NOT operation on the specified <operator-expression> and selects the documents
     * that do not match the <operator-expression>. This includes documents that do not contain the field.
     *
     * @param selector
     * @param value
     * @returns {{test: Function}}
     */
    $not: function (selector, value) {
      var criteria = {};
      criteria[selector] = normalize(value);
      var query = new Mingo.Query(criteria);
      return {
        test: function (obj) {
          return !query.test(obj);
        }
      };
    },

    $elemMatch: function (selector, value) {
      throw Error("$elemMatch not implemented yet!");
    },

    $where: function (selector, value) {
      throw Error("$where is Bad Bad Bad and SHALL NOT be implemented! Sorry :(");
    }

  };

  var simpleOperators = {

    /**
     * Pseudo operator, introduced for convenience and consistency
     * Checks that two values are equal
     *
     * @param a
     * @param b
     * @returns {*}
     */
    $eq: function (a, b) {
      a = _.isArray(a)? a : [a];
      a = _.find(a, function (val) {
        return _.isEqual(val, b);
      });
      return a !== undefined;
    },

    /**
     * $ne selects the documents where the value of the field is not equal (i.e. !=) to the specified value.
     * This includes documents that do not contain the field
     * @param a
     * @param b
     * @returns {boolean}
     */
    $ne: function (a, b) {
      return !this.$eq(a, b);
    },

    /**
     * $in selects the documents where the field value equals any value in the specified array (e.g. <value1>, <value2>, etc.)
     *
     * @param a
     * @param b
     * @returns {*}
     */
    $in: function (a, b) {
      a = _.isArray(a)? a : [a];
      return _.intersection(a, b).length > 0;
    },

    /**
     * $nin selects the documents where:
     * the field value is not in the specified array or
     * the field does not exist.
     *
     * @param a
     * @param b
     * @returns {*|boolean}
     */
    $nin: function (a, b) {
      return _.isUndefined(a) || !this.$in(a, b);
    },

    /**
     * $lt selects the documents where the value of the field is less than (i.e. <) the specified value.
     *
     * @param a
     * @param b
     * @returns {boolean}
     */
    $lt: function(a, b) {
      a = _.isArray(a)? a : [a];
      a = _.find(a, function (val) {
        return val < b
      });
      return a !== undefined;
    },

    /**
     * $lte selects the documents where the value of the field is less than or equal to (i.e. <=) the specified value.
     *
     * @param a
     * @param b
     * @returns {boolean}
     */
    $lte: function(a, b) {
      a = _.isArray(a)? a : [a];
      a = _.find(a, function (val) {
        return val <= b
      });
      return a !== undefined;
    },

    /**
     * $gt selects those documents where the value of the field is greater than (i.e. >) the specified value.
     *
     * @param a
     * @param b
     * @returns {boolean}
     */
    $gt: function(a, b) {
      a = _.isArray(a)? a : [a];
      a = _.find(a, function (val) {
        return val > b
      });
      return a !== undefined;
    },

    /**
     * $gte selects the documents where the value of the field is greater than or equal to (i.e. >=) a specified value (e.g. value.)
     *
     * @param a
     * @param b
     * @returns {boolean}
     */
    $gte: function(a, b) {
      a = _.isArray(a)? a : [a];
      a = _.find(a, function (val) {
        return val >= b
      });
      return a !== undefined;
    },

    /**
     * $mod selects the documents where the field value divided by the divisor has the specified remainder.
     * @param a
     * @param b
     * @returns {*|boolean|boolean}
     */
    $mod: function (a, b) {
      a = _.isArray(a)? a : [a];
      a = _.find(a, function (val) {
        return _.isNumber(val) && _.isArray(b) && b.length === 2 && (val % b[0]) === b[1];
      });
      return a !== undefined;
    },

    /**
     * The $regex operator provides regular expression capabilities for pattern matching strings in queries.
     * MongoDB uses Perl compatible regular expressions
     * @param a
     * @param b
     * @returns {*|boolean}
     */
    $regex: function (a, b) {
      a = _.isArray(a)? a : [a];
      a = _.find(a, function (val) {
        return _.isString(val) && _.isRegExp(b) && (!!val.match(b));
      });
      return a !== undefined;
    },

    /**
     * $exists selects the documents that contain the field if <boolean> is true.
     * If <boolean> is false, the query only returns the documents that do not contain the field.
     * @param a
     * @param b
     * @returns {boolean|*|boolean}
     */
    $exists: function (a, b) {
      return (b === false && _.isUndefined(a)) || (b === true && !_.isUndefined(a));
    },

    /**
     * $all selects the documents where the field holds an array which contains all elements (e.g. <value>, <value1>, etc.) in the array
     * @param a
     * @param b
     * @returns {*}
     */
    $all: function (a, b) {
      // order of arguments matter. underscore maintains order after intersection
      if (_.isArray(a) && _.isArray(b)) {
        return _.intersection(b, a).length === b.length;
      }
      return false;
    },

    /**
     * The $size operator matches any array with the number of elements specified by the argument. For example:
     * @param a
     * @param b
     * @returns {*|boolean}
     */
    $size: function (a, b) {
      return _.isArray(a) && _.isNumber(b) && (a.length === b);
    }

  };

  var groupOperators = {

    $addToSet: function (collection, expr) {
      var result = _.map(collection, function (obj) {
        return computeValue(obj, expr);
      });
      return _.uniq(result);
    },

    $sum: function (collection, expr) {
      if (_.isNumber(expr)) {
        // take a short cut if expr is number literal
        return collection.length * expr;
      }
      var result = _.reduce(collection, function (acc, obj) {
        // pass empty field to avoid naming conflicts with fields on documents
        return acc + computeValue(obj, expr);
      }, 0);
      return result;
    },

    $max: function (collection, expr) {
      return _.max(collection, function (obj) {
        return computeValue(obj, expr);
      });
    },

    $min: function (collection, expr) {
      return _.min(collection, function (obj) {
        return computeValue(obj, "", expr);
      });
    },

    $avg: function (collection, expr) {
      return this.$sum(collection, expr) / collection.length;
    },

    $push: function (collection, expr) {
      return _.map(collection, function (obj) {
        return computeValue(obj, expr);
      });
    },

    $first: function (collection, expr) {
      return (collection.length > 0)? computeValue(collection[0], expr) : undefined;
    },

    $last: function (collection, expr) {
      return (collection.length > 0)? computeValue(collection[collection.length - 1], expr) : undefined;
    }
  };

  var aggregateOperators = {

    $add: function (ctx) {
      var result = 0;
      flatten(ctx, _.toArray(arguments.splice(1)), function (val) {
        result += val;
      });
      return result;
    },

    $subtract: function (ctx) {
      var args = flatten(ctx, _.toArray(arguments.splice(1)));
      return args[0] - args[1];
    },

    $divide: function (ctx) {
      var args = flatten(ctx, _.toArray(arguments.splice(1)));
      return args[0] / args[1];
    },

    $multiply: function (ctx) {
      var result = 1;
      flatten(ctx, _.toArray(arguments.splice(1)), function (val) {
        result *= val;
      });
      return result;
    },

    $mod: function (ctx) {
      var args = flatten(ctx, _.toArray(arguments.splice(1)));
      return args[0] % args[1];
    },

    $cmp: function (ctx) {
      var args = flatten(ctx, _.toArray(arguments.splice(1)));
      if (args[0] > args[1]) {
        return 1;
      }
      return (args[0] < args[1])? -1 : 0;
    },

    $concat: function (ctx) {
      var args = flatten(ctx, _.toArray(arguments.splice(1)));
      return args.join("");
    },

    $strcasecmp: function (ctx) {
      var args = flatten(ctx, _.toArray(arguments.splice(1)));
      args[0] = args[0].toUpperCase();
      args[1] = args[1].toUpperCase();
      if (args[0] > args[1]) {
        return 1;
      }
      return (args[0] < args[1])? -1 : 0;
    },

    $substr: function (ctx) {
      var args = flatten(ctx, _.toArray(arguments.splice(1)));
      return args[0].substr(args[1], args[2]);
    },

    $toLower: function (ctx) {
      var args = flatten(ctx, _.toArray(arguments.splice(1)));
      return args[0].toLowerCase();
    },

    $toUpper: function (ctx) {
      var args = flatten(ctx, _.toArray(arguments.splice(1)));
      return args[0].toUpperCase();
    }
  };

  // mixin from simple operators
  _.each(["$eq", "$ne", "$gt", "$gte", "$lt", "$lte"], function (op) {
    aggregateOperators[op] = function (ctx) {
      var args = flatten(ctx, _.toArray(arguments.splice(1)));
      simpleOperators[op](args[0], args[1]);
    };
  });

  var Ops = {
    simpleOperators: _.keys(simpleOperators),
    compoundOperators: _.keys(compoundOperators),
    aggregateOperators: _.keys(aggregateOperators),
    groupOperators: _.keys(groupOperators),
    pipelineOperators: _.keys(pipelineOperators)
  };
  Ops.queryOperators = _.union(Ops.simpleOperators, Ops.compoundOperators);


  var flatten = function(obj, args, action) {
    for (var i = 0; i < args.length; i++) {
      if (_.isString(args[i]) && args[i].startsWith("$")) {
        args[i] = Mingo._resolve(obj, args[i].substr(1));
      }
      if (typeof action === "function") {
        action(args[i]);
      }
    }
    return args;
  };

  var accumulate = function (collection, field, expr) {
    if (_.contains(Ops.groupOperators, field)) {
      return groupOperators[field](collection, expr);
    }

    if (_.isObject(expr)) {
      var result = {};
      for (var key in expr) {
        result[key] = accumulate(collection, key, expr[key]);
        if (_.contains(Ops.groupOperators, key)) {
          result = result[key];
          break;
        }
      }
      return result;
    }

    return null;
  };

  var computeValue = function (record, expr, field) {

    // if the field of the object is an aggregate operator
    if (_.contains(Ops.aggregateOperators, field)) {
      return aggregateOperators[field](record, expr);
    }

    // if expr is a variable for an object field
    // field must be blank in this case
    if (_.isString(expr)) {
      if (expr.length > 0 && expr[0] === "$") {
        return Mingo._resolve(record, expr.substr(1));
      }
    }

    if (_.isObject(expr)) {
      var result = {};
      for (var key in expr) {
        result[key] = computeValue(record, expr[key], key);
        if (_.contains(Ops.aggregateOperators, key)) {
          result = result[key];
          break;
        }
      }
      return result;
    }

    // check and return value if already in a resolved state
    for (var i = 0; i < primitives.length; i++) {
      if (primitives[i](expr)) {
        return expr;
      }
    }

    return undefined;
  };

}).call(this);