/** A valid schema-1 pipeline manifest for tests. */
export const MANIFEST = {
    schema: 1,
    name: 'dev-demo',
    region: 'us-east-1',
    accountKey: 'controlled',
    classification: 'protected',
    stateMachineArn:
        'arn:aws:states:us-east-1:123456789012:stateMachine:dev-demo-pipeline',
    bucketName: 'dev-demo-pipeline',
    keyTemplate: '{stage}/{runId}/{id}',
    stages: [
        { id: 'raw', loadable: true, readable: false, description: 'source documents' },
        { id: 'chunks', loadable: false, readable: true, description: 'text chunks' },
        { id: 'final', loadable: false, readable: true, description: 'final csv' },
    ],
    inputStage: 'raw',
    resultKey: { stage: 'final', id: 'final.csv' },
};
