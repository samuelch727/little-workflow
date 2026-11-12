/** Shape schema only; installed/envelope/files/budget semantics require the portable validators. */
export declare function harnessWireSchema(stamped?: boolean): {
    $schema: string;
    $id: string;
    type: string;
    additionalProperties: boolean;
    required: string[];
    not: {
        required: string[];
    };
    properties: {
        harnessFormat: {
            const: number;
        };
        files: {
            type: string;
            maxProperties: number;
            propertyNames: {
                maxLength: number;
                pattern: string;
            };
            additionalProperties: {
                maxLength: number;
                type: string;
            };
        };
        system: {
            maxLength: number;
            type: string;
        };
        instructions: {
            maxLength: number;
            type: string;
        };
        model: {
            maxLength: number;
            type: string;
        };
        temperature: {
            type: string;
            minimum: number;
            maximum: number;
        };
        tools: {
            type: string;
            maxProperties: number;
            propertyNames: {
                type: string;
                maxLength: number;
                pattern: string;
                not: {
                    enum: string[];
                };
            };
            additionalProperties: {
                properties: {
                    implementationHash?: {
                        type: string;
                        pattern: string;
                    } | undefined;
                    schemaHash?: {
                        type: string;
                        pattern: string;
                    } | undefined;
                    enabled: {
                        type: string;
                    };
                    description: {
                        maxLength: number;
                        type: string;
                    };
                    parameterDescriptions: {
                        type: string;
                        maxProperties: number;
                        additionalProperties: {
                            maxLength: number;
                            type: string;
                        };
                    };
                };
                required?: string[] | undefined;
                type: string;
                additionalProperties: boolean;
            };
        };
        hooks: {
            type: string;
            additionalProperties: boolean;
            properties: {
                [k: string]: {
                    type: string;
                    additionalProperties: boolean;
                    required: string[];
                    properties: {
                        implementationHash?: {
                            type: string;
                            pattern: string;
                        } | undefined;
                        parameterSchemaHash?: {
                            type: string;
                            pattern: string;
                        } | undefined;
                        profile: {
                            type: string;
                            maxLength: number;
                            pattern: string;
                            not: {
                                enum: string[];
                            };
                        };
                        parameters: {
                            type: string;
                            maxProperties: number;
                            propertyNames: {
                                type: string;
                                maxLength: number;
                                pattern: string;
                                not: {
                                    enum: string[];
                                };
                            };
                            additionalProperties: {
                                type: string[];
                            };
                        };
                    };
                };
            };
        };
    };
};
