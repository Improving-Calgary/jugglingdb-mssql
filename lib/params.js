var Parameters = function (params) {
  this.params = params || [];
  this._nextParamId = params ? params.length + 1 : 1;
};

Parameters.prototype._getNextParamName = function (name) {
  var id = this._nextParamId++;
  return name || 'param' + id;
};

Parameters.prototype.add = function(name, val) {
  if (arguments.length < 2) {
    val = name;
    name = undefined;
  }
  var paramName = this._getNextParamName(name);
  this.params.push({
    name: paramName,
    value: val
  });
  return paramName;
};

module.exports = Parameters;
