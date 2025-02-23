// lib/family-tree-stack.ts
import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as iam from 'aws-cdk-lib/aws-iam';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Construct } from 'constructs';

export class FamilyTreeInfraStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // S3 Bucket for Frontend hosting
    const websiteBucket = new s3.Bucket(this, 'WebsiteBucket', {
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          expiration: cdk.Duration.days(365),
          transitions: [
            {
              storageClass: s3.StorageClass.INTELLIGENT_TIERING,
              transitionAfter: cdk.Duration.days(90),
            },
          ],
        },
      ],
    });

    // S3 Bucket for user uploads
    const uploadsBucket = new s3.Bucket(this, 'UploadsBucket', {
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      cors: [
        {
          allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.PUT],
          allowedOrigins: ['*'], // Restrict this in production
          allowedHeaders: ['*'],
        },
      ],
    });

    // Cognito User Pool
    const userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: 'family-tree-users',
      selfSignUpEnabled: true,
      signInAliases: {
        email: true,
        phone: true,
      },
      standardAttributes: {
        email: {
          required: true,
          mutable: true,
        },
        // phoneNumber: {
        //   required: true,
        //   mutable: true,
        // },
      },
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // Cognito Domain
    const domain = userPool.addDomain('FamilyTreeDomain', {
      cognitoDomain: {
        domainPrefix: 'family-tree-' + this.account,
      }
    });

    // Cognito Client
    const userPoolClient = new cognito.UserPoolClient(this, 'FamilyTreeUserPoolClient', {
      userPool,
      oAuth: {
        flows: {
          authorizationCodeGrant: true,
        },
        scopes: [cognito.OAuthScope.EMAIL, cognito.OAuthScope.OPENID, cognito.OAuthScope.PROFILE],
        callbackUrls: ['http://localhost:3000', 'http://localhost:3000/callback'], // Add your domains here
        logoutUrls: ['http://localhost:3000'],
      },
      supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.COGNITO],
      preventUserExistenceErrors: true,
    });

    // DynamoDB Tables
    const personsTable = new dynamodb.Table(this, 'PersonsTable', {
      partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      timeToLiveAttribute: 'ttl',
    });

    // Add GSIs for efficient querying
    personsTable.addGlobalSecondaryIndex({
      indexName: 'by-email',
      partitionKey: { name: 'email', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // Lambda Functions
    const apiHandler = new NodejsFunction(this, 'ApiHandler', {
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: 'handler',
      entry: 'lambda/api-handler.ts', // Create this file
      environment: {
        USER_POOL_ID: userPool.userPoolId,
        PERSONS_TABLE: personsTable.tableName,
        UPLOADS_BUCKET: uploadsBucket.bucketName,
      },
      memorySize: 128,
      timeout: cdk.Duration.seconds(10),
    });

    // Grant permissions
    personsTable.grantReadWriteData(apiHandler);
    uploadsBucket.grantReadWrite(apiHandler);

    // API Gateway
    const api = new apigateway.RestApi(this, 'FamilyTreeApi', {
      restApiName: 'Family Tree API',
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: [
          'Content-Type',
          'X-Amz-Date',
          'Authorization',
          'X-Api-Key',
          'X-Amz-Security-Token',
        ],
        allowCredentials: true,
      },
    });

    // Add Cognito Authorizer
    const authorizer = new apigateway.CognitoUserPoolsAuthorizer(this, 'ApiAuthorizer', {
      cognitoUserPools: [userPool],
    });

    // API Gateway Integration
    const integration = new apigateway.LambdaIntegration(apiHandler);
    api.root.addMethod('ANY', integration, {
      authorizer,
    });
    api.root.addProxy({
      defaultIntegration: integration,
      anyMethod: true,
    });

    // CloudFront Distribution
    const distribution = new cloudfront.Distribution(this, 'WebsiteDistribution', {
      defaultBehavior: {
        origin: new origins.S3Origin(websiteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      additionalBehaviors: {
        '/api/*': {
          origin: new origins.RestApiOrigin(api),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        },
      },
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
    });

    // Update Cognito Client with CloudFront URL
    const cfnUserPoolClient = userPoolClient.node.defaultChild as cognito.CfnUserPoolClient;
    cfnUserPoolClient.callbackUrLs = [
      'https://' + distribution.distributionDomainName,
      'https://' + distribution.distributionDomainName + '/callback',
      'http://localhost:3000',
      'http://localhost:3000/callback',
    ];
    cfnUserPoolClient.logoutUrLs = [
      'https://' + distribution.distributionDomainName,
      'http://localhost:3000',
    ];

    // Output values
    new cdk.CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId });
    new cdk.CfnOutput(this, 'UserPoolClientId', { value: userPoolClient.userPoolClientId });
    new cdk.CfnOutput(this, 'ApiUrl', { value: api.url });
    new cdk.CfnOutput(this, 'CloudFrontUrl', { value: distribution.distributionDomainName });
    new cdk.CfnOutput(this, 'Region', { value: this.region });
    new cdk.CfnOutput(this, 'CognitoDomain', { value: `${userPool.userPoolId}.auth.${this.region}.amazoncognito.com` });
    new cdk.CfnOutput(this, 'CognitoDomainName', { value: domain.domainName });

    // Output in Env variables format
    new cdk.CfnOutput(this, 'EnvVariables', {
      value: `
      REACT_APP_USER_POOL_ID=${userPool.userPoolId}
      REACT_APP_USER_POOL_CLIENT_ID=${userPoolClient.userPoolClientId}
      REACT_APP_API_URL=${api.url}
      REACT_APP_CLOUDFRONT_URL=${distribution.distributionDomainName}
      REACT_APP_REGION=${this.region}
      REACT_APP_COGNITO_DOMAIN=${userPool.userPoolId}.auth.${this.region}.amazoncognito.com
      REACT_APP_COGNITO_DOMAIN_NAME=${domain.domainName}
      `,
    });
  }
}
