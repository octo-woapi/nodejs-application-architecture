const path = require("path");
const express = require("express");
const bunyan = require("bunyan");
const cors = require("cors");
const bodyParser = require("body-parser");
const Sequelize = require("sequelize");
const Joi = require("joi");

const env = process.env.NODE_ENV || "development";
const conf = require(path.resolve(__dirname, "conf", env));
const Op = Sequelize.Op;

const logLevel = process.env.LOG_LEVEL || "info";
const logger = bunyan.createLogger({ name: conf.appname, level: logLevel });

let sequelize = undefined;
if (env === "production") {
  sequelize = new Sequelize(conf.db.uri);
} else {
  sequelize = new Sequelize(
    conf.db.database,
    conf.db.username,
    conf.db.password,
    conf.db.sequelize
  );
}

const Product = sequelize.define("product", {
  name: Sequelize.STRING,
  price: Sequelize.INTEGER,
  weight: Sequelize.INTEGER
});

const productSchema = Joi.object().keys({
  name: Joi.required(),
  price: Joi.required(),
  weight: Joi.required()
});

const Order = sequelize.define("order", {
  status: {
    type: Sequelize.ENUM("pending", "cancelled", "paid"),
    defaultValue: "pending"
  },
  shipment_amount: {
    type: Sequelize.INTEGER,
    defaultValue: 25
  },
  total_amount: Sequelize.INTEGER,
  total_weight: Sequelize.INTEGER
});

Order.hasMany(Product, { as: "ProductList" });

const orderSchema = Joi.object().keys({
  product_list: Joi.array()
    .items(Joi.number())
    .required()
});

const Bill = sequelize.define("bill", {
  total_amount: Sequelize.INTEGER
});

module.exports = async () => {
  const app = express();
  await sequelize.sync({});

  app.use(bodyParser.json());

  app.use((req, res, next) => {
    logger.debug({
      method: req.method,
      host: req.headers.host,
      url: req.url,
      useragent: req.headers["user-agent"]
    });
    next();
  });

  app.use(cors());

  app.use(/\/products|orders|bills/, (req, res, next) => {
    res.set("Content-Type", "application/json");
    next();
  });

  /**
   * @swagger
   * /products:
   *   post:
   *     tags:
   *       - Products
   *     description: Create a product
   *     produces:
   *       - application/json
   *     responses:
   *       201:
   *         description: Nothing
   */
  app.post("/products", async (req, res) => {
    const { error } = Joi.validate(req.body, productSchema, {
      abortEarly: false
    });

    if (error) {
      const errorMessage = error.details.map(({ message, context }) =>
        Object.assign({ message, context })
      );
      return res.status(400).send({ data: errorMessage });
    }

    const product = await Product.create(req.body);
    res.set("Location", `/products/${product.id}`);
    res.status(201).send();
  });

  /**
   * @swagger
   * /products:
   *   get:
   *     tags:
   *       - Products
   *     description: Returns all product
   *     produces:
   *       - application/json
   *     responses:
   *       200:
   *         description: An array of products
   */
  app.get("/products", async (req, res) => {
    let productList = await Product.findAll();
    const { sort } = req.query;
    productList = productList.sort((a, b) => {
      if (a[sort] < b[sort]) return -1;
      if (a[sort] > b[sort]) return 1;
      return 0;
    });
    res.status(200).send(productList);
  });

  /**
   * @swagger
   * /products/:id:
   *   get:
   *     tags:
   *       - Products
   *     description: Get a single product
   *     produces:
   *       - application/json
   *     responses:
   *       200:
   *         description: A single product
   */
  app.get("/products/:id", async (req, res) => {
    const { id } = req.params;
    const product = await Product.findById(id);
    if (!product) return res.status(404).send();
    return res.status(200).send(product.toJSON());
  });

  /**
   * @swagger
   * /products:
   *   delete:
   *     tags:
   *       - Products
   *     description: Delete all products
   *     produces:
   *       - application/json
   *     responses:
   *       204:
   *         description: Nothing
   */
  app.delete("/products", async (req, res) => {
    const productList = await Product.findAll();
    productList.forEach(product => product.destroy());
    res.status(204).send();
  });

  /**
   * @swagger
   * /orders:
   *   post:
   *     tags:
   *       - Orders
   *     description: Create an order
   *     produces:
   *       - application/json
   *     responses:
   *       201:
   *         description: Nothing
   */
  app.post("/orders", async (req, res) => {
    const { error } = Joi.validate(req.body, orderSchema, {
      abortEarly: false
    });

    if (error) {
      const errorMessage = error.details.map(({ message, context }) =>
        Object.assign({ message, context })
      );
      return res.status(400).send({ data: errorMessage });
    }

    const productList = await Product.findAll({
      where: {
        id: { [Op.in]: req.body.product_list.map(id => parseInt(id, 0)) }
      }
    });

    if (productList.length === 0) {
      return res.status(400).send({
        data: [
          { message: "Unknown products", context: { key: "product_list" } }
        ]
      });
    }

    const productListData = productList.map(product => product.toJSON());

    const orderTotalWeight = productListData
      .map(p => p.weight)
      .reduce((prev, cur) => prev + cur, 0);

    const orderProductListPrice = productListData
      .map(p => p.price)
      .reduce((prev, cur) => prev + cur, 0);

    const SHIPMENT_PRICE_STEP = 25;
    const SHIPMENT_WEIGHT_STEP = 10;
    const orderShipmentPrice =
      SHIPMENT_PRICE_STEP * Math.round(orderTotalWeight / SHIPMENT_WEIGHT_STEP);

    let totalAmount = orderProductListPrice + orderShipmentPrice;

    const DISCOUNT_THRESHOLD = 1000;
    const DISCOUNT_RATIO = 0.95;
    if (totalAmount > DISCOUNT_THRESHOLD) {
      totalAmount = totalAmount * DISCOUNT_RATIO;
    }

    const orderData = Object.assign(
      {
        total_amount: totalAmount,
        shipment_amount: orderShipmentPrice,
        total_weight: orderTotalWeight
      },
      { product_list: req.body.product_list }
    );

    const order = await Order.create(orderData);
    res.set("Location", `/orders/${order.id}`);
    res.status(201).send();
  });

  /**
   * @swagger
   * /orders:
   *   get:
   *     tags:
   *       - Orders
   *     description: List all order
   *     produces:
   *       - application/json
   *     responses:
   *       200:
   *         description: An array of orders
   */
  app.get("/orders", async (req, res) => {
    let orderList = await Order.findAll();
    const { sort } = req.query;
    orderList = orderList.sort((a, b) => {
      if (a[sort] < b[sort]) return -1;
      if (a[sort] > b[sort]) return 1;
      return 0;
    });
    res.status(200).send(orderList);
  });

  /**
   * @swagger
   * /orders/:id:
   *   get:
   *     tags:
   *       - Orders
   *     description: Get a single order
   *     produces:
   *       - application/json
   *     responses:
   *       200:
   *         description: Nothing
   */
  app.get("/orders/:id", async (req, res) => {
    const { id } = req.params;
    const order = await Order.findById(id);
    if (!order) return res.status(404).send();
    return res.status(200).send(order.toJSON());
  });

  /**
   * @swagger
   * /orders:
   *   delete:
   *     tags:
   *       - Orders
   *     description: Delete all orders
   *     produces:
   *       - application/json
   *     responses:
   *       204:
   *         description: Nothing
   */
  app.delete("/orders", async (req, res) => {
    const orderList = await Order.findAll();
    orderList.forEach(order => order.destroy());
    res.status(204).send();
  });

  /**
   * @swagger
   * /orders/:id/status:
   *   put:
   *     tags:
   *       - Orders
   *     description: Change an order status
   *     produces:
   *       - application/json
   *     responses:
   *       200:
   *         description: Nothing
   */
  app.put("/orders/:id/status", async (req, res) => {
    const { id } = req.params;
    const order = await Order.findById(id);
    if (!order) return res.status(404).send();

    const { status } = req.body;
    if (!["pending", "paid", "cancelled"].includes(status)) {
      return res.status(400).send();
    }

    if (status === "paid") {
      Bill.create({ total_amount: order.toJSON().total_amount });
    }

    await order.update({ status });

    return res.status(200).send();
  });

  /**
   * @swagger
   * /bills:
   *   get:
   *     tags:
   *       - Bills
   *     description: Returns all bills
   *     produces:
   *       - application/json
   *     responses:
   *       200:
   *         description: An array of bills
   */
  app.get("/bills", async (req, res) => {
    let billList = await Bill.findAll();
    res.status(200).send(billList);
  });

  /**
   * @swagger
   * /bills:
   *   delete:
   *     tags:
   *       - Bills
   *     description: Delete all bills
   *     produces:
   *       - application/json
   *     responses:
   *       204:
   *         description: Nothing
   */
  app.delete("/bills", async (req, res) => {
    const billList = await Bill.findAll();
    billList.forEach(bill => bill.destroy());
    res.status(204).send();
  });

  const swaggerJSDoc = require("swagger-jsdoc");
  const swaggerUi = require("swagger-ui-express");

  // swagger definition
  const swaggerDefinition = {
    info: {
      title: "Node Swagger API",
      version: "1.0.0",
      description: "Demonstrating how to describe a RESTful API with Swagger"
    },
    host:
      env === "development"
        ? "localhost:3000"
        : "https://calm-plains-26467.herokuapp.com/",
    basePath: "/"
  };

  // options for the swagger docs
  const options = {
    // import swaggerDefinitions
    swaggerDefinition: swaggerDefinition,
    // path to the API docs
    apis: ["./index.js"]
  };

  // initialize swagger-jsdoc
  const swaggerSpec = swaggerJSDoc(options);

  app.get("/swagger.json", function(req, res) {
    res.setHeader("Content-Type", "application/json");
    res.send(swaggerSpec);
  });

  app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));

  return app;
};
